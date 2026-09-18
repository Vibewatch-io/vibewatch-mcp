#!/usr/bin/env python3
"""
Vibewatch branch-protection guard for Bash-mediated file edits (PreToolUse).

The companion .claude/hooks/branch-reminder.sh only fires on Edit / Write /
MultiEdit / NotebookEdit. Bash invocations like `sed -i 's/.../...' file`,
heredoc redirects, `tee`, and bare shell redirection (`> file`, `>> file`)
skip that hook entirely — which means a writer can dump changes onto main
through Bash without the protected-branch reminder firing.

This guard reads the Bash tool input, classifies the command as edit-y or
not, and on main emits the same branch-protection reminder. On any
other branch the guard is a no-op (the noisy "are you on the right branch?"
nudge only makes sense for explicit Edit tools — Bash sees a lot of
read-only commands that don't deserve a per-command nudge).

Exit behavior: on any non-protected branch (or for non-edit-y commands) the
guard is a no-op and exits 0. On main, when the Bash command looks
file-mutating, it exits 2 — which makes PreToolUse block the tool call and
surface the protected-branch reminder into Claude's context.
"""

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path


# Commands that write to / mutate files. Matched against the bash command
# string; conservative — we accept some misses to keep false positives low.
#
# Intentionally NOT blocked: `git checkout` (with or without -b/-B) and
# `git switch`. These are the escape hatch from main — the protection
# message itself tells the writer to run `git checkout -b feature/<name>
# origin/<base>`, so the guard must not block that command. Other git
# subcommands that mutate worktree or index (add, rm, mv, reset, stash,
# clean, branch -D) stay listed.
EDIT_PATTERNS = [
    r"\bsed\s+(?:-[^\s]*\s+)*-[^\s]*i",                  # sed -i, sed -e -i, etc
    r"\bsed\s+--in-place\b",
    r"\bperl\s+-pi\b",
    r"\bperl\s+-i\b",
    r"\bawk\s+-i\s+inplace\b",
    r"\bgsed\s+-i\b",
    r">\s*[^\s>&|;)]+",                                  # any single `>` redirect
    r">>\s*[^\s>&|;)]+",                                 # `>>` append
    r"\btee\s+[^\s]+",                                   # tee file
    r"\btruncate\s+",
    r"\bmkdir\s+",
    r"\bmv\s+",
    r"\brm\s+",
    r"\bcp\s+",
    r"\btouch\s+",
    r"\bln\s+",
    r"\bchmod\s+",
    r"\bchown\s+",
    r"(?<![\w.-])(?:dd|rmdir|shred|unlink|rsync)\s+",
    r"\bgit\s+(?:add|rm|mv|reset|stash|clean|branch\s+-D)\b",
    r"\bcat\s+<<",                                       # heredoc into command
]
_EDIT_RE = re.compile("|".join(EDIT_PATTERNS))


# Path-like token shapes we recognize. Used to decide whether a command's
# targets are clearly outside the worktree (e.g. /tmp/foo, ~/scratch).
_PATH_TOKEN_RE = re.compile(r"""
    (?:^|[\s'"=<>|;&])                # delimiter
    (
        ~/[^\s'";|&<>]+                # ~/scratch
        | /[^\s'";|&<>]+               # /tmp/foo
        | \./[^\s'";|&<>]+             # ./local
        | \.\./[^\s'";|&<>]+           # ../parent
        | [^\s'";|&<>-][\w./-]*\.\w+    # bare-name with extension (foo.py)
    )
""", re.VERBOSE)


_SHELL_OPERATORS = sorted(
    {"&>>", "<<<", "<<", ">>", "&&", "||", ";;", "|&", ">|", "<>", "&>", ">&",
     "<&", "<(", ">(", "(", ")", ";", "|", "&", "<", ">"},
    key=len, reverse=True,
)


_GLUED_SUFFIX = "\x00"


def _space_operators(command):
    """Surround every UNQUOTED shell operator with spaces before shlex runs.

    shlex's punctuation_chars coalesces a run of punctuation into one token
    (`);`, `)&&`, `))`), and it strips quotes, so splitting afterwards cannot
    tell the operator run in `cp <(cat /tmp/a)&& touch README` from the quoted
    filename in `cp /tmp/in ')&&'`. Splitting here, while quote state is still
    visible, keeps both right. An unquoted newline becomes `;` (shlex treats it
    as plain whitespace) and unquoted backticks become `$(` / `)` so the
    command inside them is parsed as its own command substitution.
    """
    # Quoted or escaped punctuation is a literal filename character. shlex
    # strips the quotes, so replace it with `_` (which keeps a token bare and
    # non-path-shaped) to stop `')&&'` or `\;` turning into an operator.
    def literal(c):
        return "_" if c in "();<>|&" else c

    out = []
    paren_kinds = []  # per open `(`: (is_substitution, out index where it opened)

    def at_word_start():
        # Out entries are single chars, two-char escapes (`\ `), or spaced
        # operators (` ; `), so a one-char or operator entry ending in
        # whitespace means the next char starts a new word.
        return not out or (out[-1][-1:].isspace() and len(out[-1]) != 2)

    def glued_suffix_marker(j):
        # Text glued after a closing `)` / backtick (`/tmp/l-$(date).log`)
        # continues the word before the substitution. Spacing the `)` splits
        # it off, so tag it for the parser to skip: the word's prefix already
        # decided whether it is in-repo.
        if j < len(command) and not command[j].isspace() and command[j] not in "();<>|&":
            return _GLUED_SUFFIX
        return ""

    quote = None
    backtick_open = False
    i = 0
    while i < len(command):
        ch = command[i]
        if quote:
            if quote == "$'":
                # shlex has no ANSI-C quoting, so emit the word unquoted with
                # its quotes and escapes flattened to `_`.
                if ch == "\\" and i + 1 < len(command):
                    out.append("__")
                    i += 2
                    continue
                if ch == "'":
                    quote = None
                out.append("_" if ch in "'\"\\ \t\n" else literal(ch))
                i += 1
                continue
            if ch == "\\" and quote == '"' and i + 1 < len(command):
                out.append(ch + literal(command[i + 1]))
                i += 2
                continue
            if ch == quote:
                quote = None
            out.append(literal(ch))
            i += 1
            continue
        if ch == "\\" and i + 1 < len(command):
            out.append(ch + literal(command[i + 1]))
            i += 2
            continue
        if command.startswith("$'", i):
            # ANSI-C quoting: backslash escapes the quote (`$'\''`).
            quote = "$'"
            out.append("__")
            i += 2
            continue
        if ch in "'\"":
            quote = ch
            out.append(ch)
        elif ch == "#" and at_word_start():
            # A word-start `#` comments out the rest of the line. Mid-word
            # (`/tmp/a#x`, or after an escaped space `a\ #x`, whose out entry
            # is the two-char escape) it is literal, which shlex's commenters
            # get wrong.
            end = command.find("\n", i)
            i = len(command) if end == -1 else end
            continue
        elif ch == "\n":
            out.append(" ; ")
        elif ch == "`":
            # Rewritten as `$(`: space-led at a word start, glued otherwise
            # (`/tmp/x-`date``), so the tokenizer tells the two apart.
            if backtick_open:
                out.append(" ) " + glued_suffix_marker(i + 1))
            else:
                out.append(" $( " if at_word_start() else "$( ")
            backtick_open = not backtick_open
        elif ch in "();<>|&":
            op = next(o for o in _SHELL_OPERATORS if command.startswith(o, i))
            marker = ""
            if op in ("(", "<(", ">("):
                # Only a `)` closing a substitution can have a word glued on;
                # a group or `case x in a)` pattern `)` is a real boundary.
                substitution = bool(op != "(" or (out and out[-1].endswith("$")))
                paren_kinds.append((substitution, len(out)))
            elif op == ")" and paren_kinds:
                substitution, start = paren_kinds[-1]
                # `case` / `esac` only count as the first word of a command, so
                # `$(grep -c case f)` is not mistaken for an open case.
                firsts = [seg.split()[0] for seg in re.split(r"[;&|()]", "".join(out[start:]))
                          if seg.split()]
                if firsts.count("case") <= firsts.count("esac"):  # not a case pattern
                    paren_kinds.pop()
                    if substitution:
                        marker = glued_suffix_marker(i + 1)
            out.append(f" {op} " + marker)
            i += len(op)
            continue
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def _bare_inrepo_operands(command):
    """Bare-name operands that resolve into the cwd (in-repo) but that
    `_PATH_TOKEN_RE` can't see — it only matches tokens with a slash, a `~`,
    or a `.extension`. The motivating case is the `README` in
    `cp /tmp/x README`: the only regex-recognized token is the outside
    `/tmp/x`, so `_targets_clearly_outside_repo` would wrongly conclude every
    target is outside and let an in-repo write through on a protected branch
    (#832).

    Tokenizes with shlex and returns the bare operands — but ONLY for commands
    that take file-path operands (`cp`, `mv`, `touch`, `git`, …); a bare word
    after `echo`/`printf`/`sed`/etc. is payload, not a file, so it's ignored
    (otherwise `echo hi >/tmp/out` would falsely look like an in-repo write).
    Within a file-operand command we still skip the program word, option flags
    (`-x`) and chmod modes (`+x`), numeric option values and modes,
    `=`-assignments, input redirects, and anything already path-shaped that
    `_PATH_TOKEN_RE` covers (slash / `~` / a non-leading dot, e.g. `foo.py`).
    Leading-dot dotfiles (`.env`) are NOT treated as path-shaped — the regex
    misses them too, so they must be caught here. Whatever survives is a relative
    name that lands inside the cwd, so its presence means we CANNOT prove the
    command's targets are all outside the repo. On any tokenization failure
    (unbalanced quotes, etc.) returns [] so the regex path alone decides.

    This is a seatbelt against accidental protected-branch writes, not a
    security boundary. Known gaps, accepted to keep scratch work usable:
    words with expansions (`$PWD/README`, `/tmp/a{,README}`), relative slashed
    paths (`sub/dir`), command substitutions inside double quotes, and heredoc
    bodies (their lines are scanned as words, so `> quote` lines can fire).

    Conservative by design: a bare *source* operand (e.g. `mv file /tmp/dest`)
    also counts, because most of these commands mutate their sources too and
    the guard's contract is "prove EVERY target is outside" — when unsure,
    fire. `cp` is the one exception (sources are read-only, so only its last
    operand counts). Bare redirect targets (`> README`) and env-assignment
    prefixes (`FOO=1 cp …`) are handled explicitly.
    """
    # An fd number GLUED to a redirect (`2>&1`, `2> /tmp/err`) is an fd, but
    # shlex splits it off as a bare `2` indistinguishable from the filename in
    # `touch 2 > /tmp/out`. Strip glued fds on the raw string, where the
    # spacing is still visible, so a spaced numeric operand survives as a
    # filename.
    command = re.sub(r"(?<!\S)\d+(?=[<>])", "", command)
    try:
        lexer = shlex.shlex(_space_operators(command), posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""  # _space_operators already dropped real (word-start) comments
        tokens = []
        for tok in lexer:
            # shlex splits the `$` off a command substitution's `(`.
            if tok == "(" and tokens and tokens[-1] == "$":
                tokens[-1] = "$("  # word-start: the substitution is its own word
            elif tok == "(" and tokens and tokens[-1].endswith("$"):
                tokens[-1] = tokens[-1][:-1]  # glued (`/tmp/x-$(date)`): part of that word
                tokens.append("glued$(")
            else:
                tokens.append(tok)
    except ValueError:
        return []

    # With punctuation_chars=True, compound operators (`&&`, `||`, `>>`, `<<`)
    # arrive as standalone multi-char tokens. Command separators start a fresh
    # simple command, so the NEXT token is a program word, not a target.
    command_separators = {"|", "&", ";", "&&", "||", ";;", "|&"}
    # Redirect operators are followed by a redirect TARGET, not a command word.
    # Output-capable redirects can create/truncate their target; input-only
    # ones (`< file`, heredoc delimiters, `<&`) never write, so their operand
    # is consumed but not counted.
    output_redirect_ops = {">", ">>", ">|", "<>", "&>", "&>>", ">&"}
    input_redirect_ops = {"<", "<<", "<<<", "<&"}
    redirect_ops = output_redirect_ops | input_redirect_ops
    # Only commands that take FILE-PATH operands contribute bare in-repo targets.
    # For others (echo/printf/sed/perl/…), a trailing bare word is payload, not a
    # file — `echo hi >/tmp/out` writes only the redirect target, so treating
    # `hi` as an in-repo write would wrongly block an outside-repo scratch write.
    # Path-shaped (`_PATH_TOKEN_RE`) and bare redirect targets are still handled
    # for any command; this set only gates the *bare operand* heuristic.
    # `git` is intentionally excluded: its operand grammar (subcommands,
    # `-C <dir>`, `--work-tree`, pathspecs) is too varied for this flat
    # heuristic — e.g. `git -C /tmp/scratch add README` operates on a different
    # repo entirely. In-repo git mutations (`git add README`, `git mv a b`)
    # still fire via the no-recognized-path-tokens fallback in
    # `_targets_clearly_outside_repo`, so dropping git here only stops the
    # false-positive on outside-the-worktree git commands.
    file_operand_commands = {
        "cp", "mv", "rm", "rmdir", "touch", "mkdir", "ln", "tee", "truncate",
        "chmod", "chown", "install", "dd", "shred", "unlink", "rsync",
    }
    # Commands where a bare numeric operand is a mode / owner / size, not a
    # filename. For every other file-operand command (`touch 123`, `mkdir 2026`)
    # a numeric token IS a relative filename that lands in the cwd.
    numeric_operand_commands = {"chmod", "chown", "chgrp", "install", "truncate", "dd", "shred"}
    # Options whose separate-word value may be numeric (`mkdir -m 700`,
    # `rsync --timeout 30`): a numeric token right after one is that value,
    # not a filename. Non-numeric values stay counted (conservative).
    numeric_value_options = {
        "mkdir": ("m", {"--mode"}),
        "touch": ("td", {"--date"}),
        "rsync": ("B", {
            "--timeout", "--contimeout", "--bwlimit", "--port", "--max-size",
            "--min-size", "--block-size", "--modify-window", "--max-delete",
        }),
    }
    # Options whose separate-word value is never a file this command writes
    # (`rsync --exclude README`), so it is skipped whatever it looks like.
    pattern_value_options = {
        "rsync": ("fe", {
            "--exclude", "--include", "--filter", "--rsh", "--chmod", "--chown",
            "--out-format", "--info", "--debug", "--suffix", "--usermap",
            "--groupmap", "--iconv", "--sockopts",
        }),
    }
    # Process substitutions (`cp <(cat /tmp/a) README`) nest a command inside
    # an outer one; they are never a redirect target themselves.
    process_substitutions = {"<(", ">("}
    substitution_opens = process_substitutions | {"$(", "glued$("}
    assignment_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

    def path_shaped(t):
        # Everything _PATH_TOKEN_RE already sees: slashed, `~`, or a
        # non-leading-dot name (`foo.py`). Leading-dot dotfiles are NOT
        # path-shaped — the regex misses them, so they count as bare.
        return "/" in t or t.startswith("~") or ("." in t and not t.startswith("."))

    # Prefix commands that run the next word as the real program
    # (`sudo cp /tmp/a README`), with their options that take a value.
    command_wrappers = {
        "sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--chdir"},
        "env": {"-u", "-C", "-S", "--chdir"},
        "nice": {"-n"},
        "command": set(), "exec": set(), "nohup": set(), "time": set(),
    }
    # Wrapper options that change the wrapped command's working directory
    # (`env -C /tmp touch README` writes /tmp/README).
    chdir_options = {"sudo": {"-D", "--chdir"}, "env": {"-C", "--chdir"}}

    def new_command():
        return {
            "name": None,
            "operands": [],  # (token, is_bare)
            "target": None,  # GNU `cp -t DIR` / `--target-directory=DIR`: the one mutable operand
            "expect": None,  # the next token is a "cp_target", "cp_suffix" or "numeric_value"
            "end_of_options": False,  # after `--`, every token is an operand
            "chdir": None,  # working directory set by a wrapper (`env -C DIR`)
        }

    skip_values = {"inplace"}  # awk -i inplace operand, not a path
    bare = []
    cmd = new_command()
    expect_command = True
    redirect_target = None  # the redirect op whose target is the next token
    # One (outer_cmd, expect_command, role, case_depth) entry per open `(`.
    # A substitution suspends the outer command, restored at the matching `)`
    # so its later operands still count; a plain group stores outer_cmd=None
    # (its `)` ends the command like `;`). case_depth tells a `case` pattern's
    # `)` (`case x in a) …`) apart from the one closing this entry.
    paren_stack = []
    case_depth = 0

    def flush():
        nonlocal cmd
        if cmd["chdir"] is not None:
            # Relative operands land in the wrapper's directory, which
            # _PATH_TOKEN_RE checks when it is path-shaped; a bare one is
            # itself relative to the cwd.
            if not path_shaped(cmd["chdir"]):
                bare.append(cmd["chdir"])
            cmd = new_command()
            return
        ops = cmd["operands"]
        if cmd["name"] == "cp":
            # cp never mutates its sources — only the destination can land in
            # the repo, so `cp README /tmp/out` is a legitimate scratch read on
            # a protected branch. The destination is the last operand, or the
            # `-t DIR` operand when that form is used.
            ops = [cmd["target"]] if cmd["target"] is not None else ops[-1:]
        bare.extend(t for t, is_bare in ops if is_bare)
        cmd = new_command()

    def parse_cp_option(tok):
        # GNU cp options that take a value: -t/--target-directory and
        # -S/--suffix. Long options accept any unambiguous prefix (`--targ`,
        # `--su`); short ones may be clustered (`-rt DIR`, `-rtDIR`, `-St`).
        if tok.startswith("--"):
            name, eq, value = tok.partition("=")
            if len(name) >= 3 and "--target-directory".startswith(name):
                if eq:
                    cmd["target"] = (value, not path_shaped(value))
                else:
                    cmd["expect"] = "cp_target"
            elif len(name) >= 4 and "--suffix".startswith(name) and not eq:
                cmd["expect"] = "cp_suffix"
            return
        for i, ch in enumerate(tok[1:], start=1):
            if ch not in "St":
                continue
            value = tok[i + 1:]
            if ch == "t" and value:
                cmd["target"] = (value, not path_shaped(value))
            elif not value:
                cmd["expect"] = "cp_target" if ch == "t" else "cp_suffix"
            return  # the rest of the cluster was this option's value

    for tok in tokens:
        if tok.startswith(_GLUED_SUFFIX):
            continue  # rest of the word a substitution was glued into
        if redirect_target is not None and tok not in substitution_opens:
            op, redirect_target = redirect_target, None
            if op in input_redirect_ops:
                continue  # `< README`, `<<EOF`: read-only, never a write target
            if not tok or tok.isdigit() or tok == "-" or "$" in tok:
                # fd dup / close (`2>&1`, `>&-`), an arithmetic comparison
                # (`(( n > 0 ))`), or a variable (`> "$f"`) — as in base,
                # none is treated as an in-repo file.
                continue
            if path_shaped(tok):
                continue  # _PATH_TOKEN_RE sees it
            # A BARE output-redirect target (`cat /tmp/x > README`) is not
            # path-shaped, so nothing else sees it — it lands in the cwd.
            bare.append(tok)
            continue
        if tok in substitution_opens:
            # How the substitution counts once it closes: "operand" (bare=True)
            # for a command substitution, whose output is an unknown word
            # (`cp /tmp/a `x``); "fd" (bare=False) for a process substitution,
            # a /dev/fd path; "target" when a command substitution names a
            # redirect target (`> `printf README``), an unknown write; None
            # for a process substitution as a redirect target (`> >(tee x)`)
            # and for a substitution glued into a word already counted.
            if tok == "glued$(":
                role = None
            elif redirect_target is not None:
                role = "target" if tok == "$(" else None
            else:
                role = "operand" if tok == "$(" else "fd"
            paren_stack.append((cmd, expect_command, role, case_depth))
            cmd, expect_command, redirect_target = new_command(), True, None
            continue
        if tok == "(":
            flush()
            paren_stack.append((None, None, None, case_depth))
            expect_command, redirect_target = True, None
            continue
        if tok == ")":
            flush()
            redirect_target = None
            if case_depth > (paren_stack[-1][3] if paren_stack else 0):
                expect_command = True  # a `case` pattern's `)`, not a close
                continue
            outer = paren_stack.pop() if paren_stack else None
            if outer is None or outer[0] is None:
                expect_command = True
                if outer is not None:
                    case_depth = outer[3]
            else:
                cmd, expect_command, role, case_depth = outer
                if role == "target":
                    bare.append("<substitution>")
                elif role and cmd["name"] in file_operand_commands:
                    expect, cmd["expect"] = cmd["expect"], None
                    if expect == "cp_target":
                        # `cp -t $(x) /tmp/a`: the unknown word is the destination.
                        cmd["target"] = ("<substitution>", role == "operand")
                    elif expect is None:
                        cmd["operands"].append(("<substitution>", role == "operand"))
                    # else: it was a pending option's value (`-S $(x)`, `-m $(x)`)
            redirect_target = None
            continue
        if tok in command_separators:
            flush()
            expect_command = True
            redirect_target = None
            continue
        if tok in redirect_ops:
            redirect_target = tok
            continue
        if expect_command:
            if assignment_re.match(tok):
                continue  # env-assignment prefix (`FOO=1 cp …`); program word still to come
            if tok == "case":
                case_depth += 1
            elif tok == "esac":
                case_depth = max(case_depth - 1, 0)
            wrapper = cmd["name"] if cmd["name"] in command_wrappers else None
            if wrapper and cmd["expect"] in ("wrapper_value", "wrapper_chdir"):
                if cmd["expect"] == "wrapper_chdir":
                    cmd["chdir"] = tok
                cmd["expect"] = None
                continue  # value of a wrapper option (`sudo -u bob`)
            if wrapper and tok.startswith("-"):
                name, eq, value = tok.partition("=")
                if name in chdir_options.get(wrapper, ()):
                    if eq:
                        cmd["chdir"] = value
                    else:
                        cmd["expect"] = "wrapper_chdir"
                elif tok in command_wrappers[wrapper]:
                    cmd["expect"] = "wrapper_value"
                continue
            name = tok.rsplit("/", 1)[-1]
            cmd["name"] = name
            if name not in command_wrappers:
                expect_command = False  # program name (cp, mv, git, …) — not a target
            continue
        name = cmd["name"]
        if name not in file_operand_commands:
            continue  # payload arg for a non-file-operand command (echo, sed, …)
        expect, cmd["expect"] = cmd["expect"], None
        if expect == "cp_target":
            cmd["target"] = (tok, not path_shaped(tok))
            continue
        if expect == "cp_suffix":
            continue  # `-S SUFFIX` value, even when it looks like `-t`
        if expect == "skip_value":
            continue  # value of a non-file option (`rsync --exclude README`)
        if expect == "numeric_value" and tok.isdigit():
            continue  # value of the preceding option (`-m 700`)
        if not tok or tok.startswith("+"):  # empty word / chmod mode
            continue
        if tok.startswith("-") and tok != "-" and not cmd["end_of_options"]:
            if tok == "--":
                cmd["end_of_options"] = True
            elif name == "cp":
                parse_cp_option(tok)
            elif "=" not in tok:
                for table, expect in ((pattern_value_options, "skip_value"),
                                      (numeric_value_options, "numeric_value")):
                    if name in table:
                        shorts, longs = table[name]
                        if tok in longs or (not tok.startswith("--") and tok[-1] in shorts):
                            cmd["expect"] = expect
                            break
            continue
        if tok.isdigit() and name in numeric_operand_commands:
            continue  # numeric mode / owner / size, not a filename
        if name == "dd":
            if tok.startswith("of="):  # dd's only write target
                cmd["operands"].append((tok[3:], not path_shaped(tok[3:])))
            continue
        if "=" in tok or tok in skip_values:
            continue
        cmd["operands"].append((tok, not path_shaped(tok)))
    flush()
    return bare


def _targets_clearly_outside_repo(command, project_dir):
    """Return True only when every target in the command can be proven to live
    outside the worktree.

    The heuristic is intentionally conservative — if we can't prove every
    target is outside the repo, we return False so the guard fires. That keeps
    `mv src /tmp/dest` (in-repo source), `cp /tmp/x README` (bare in-repo
    dest), and `mkdir foo/bar` (relative path lands in cwd) blocked, while
    letting `mkdir /tmp/foo`, `cp /tmp/a /tmp/b`, and `touch ~/scratch.txt`
    through. Bare-name operands are checked via `_bare_inrepo_operands` since
    `_PATH_TOKEN_RE` only recognizes slash/`~`/dotted tokens.
    """
    abs_project = str(Path(project_dir).resolve())
    home = str(Path.home())
    tokens = _PATH_TOKEN_RE.findall(" " + command)
    for tok in tokens:
        # Skip git refs like origin/main / feature/foo that look path-like
        if tok.startswith(("origin/", "upstream/", "refs/")):
            continue
        if tok.startswith("~"):
            expanded = home + tok[1:]
        elif tok.startswith("/"):
            expanded = tok
        else:
            # Relative — could resolve to inside the repo. Be conservative.
            return False
        expanded = os.path.normpath(expanded)  # `/tmp/../repo/README` is in the repo
        if expanded == abs_project or expanded.startswith(abs_project + os.sep):
            return False  # touches inside repo
    # A bare relative operand (no slash/extension) lands in the cwd → in-repo.
    if _bare_inrepo_operands(command):
        return False
    # No recognized path tokens at all and no bare operands → nothing we can
    # prove is outside, so don't claim it is.
    if not tokens:
        return False
    return True


def current_branch(project_dir):
    try:
        out = subprocess.check_output(
            ["git", "-C", project_dir, "branch", "--show-current"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return out.decode().strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def looks_like_edit(command):
    if not command:
        return False
    return bool(_EDIT_RE.search(command))


def main():
    if os.environ.get("VIBEWATCH_BASH_EDIT_GUARD_DISABLE") == "1":
        sys.exit(0)

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    tool_input = payload.get("tool_input", {}) or {}
    command = tool_input.get("command", "")
    if not looks_like_edit(command):
        sys.exit(0)

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    branch = current_branch(project_dir)
    if branch != "main":
        # Non-protected branches: branch-reminder.sh already handles the
        # "is this the right branch?" nudge on explicit Edit tools and
        # dedupes per session. Bash commands on feature branches don't
        # need a per-command echo.
        sys.exit(0)

    # Even on protected branches, allow commands whose path targets are
    # clearly outside the worktree (mkdir /tmp/foo, touch ~/scratch.txt,
    # cp file /tmp/dest, etc.). The worktree is what matters — scratch-
    # space operations don't risk leaving uncommitted changes on main.
    if _targets_clearly_outside_repo(command, project_dir):
        sys.exit(0)

    msg = (
        f"You are on protected branch '{branch}' and the Bash command looks "
        "file-mutating. Per CLAUDE.md, all changes must go through a feature "
        "branch + PR — `git checkout -b feature/<name> origin/<base>` before "
        "running this command. (This guard catches sed -i / redirects / "
        "git mv / etc. that bypass the Edit/Write hook.)"
    )
    # Exit 2 makes PreToolUse block the tool call and surfaces the message
    # into Claude's context. For protected branches this is the desired
    # behavior — refuse the write outright.
    print(msg, file=sys.stderr)
    sys.exit(2)


def _selftest():
    """`python bash_edit_guard.py --selftest` — covers the bare-basename gap
    (#832) plus the documented scratch-space allow-throughs. project_dir is a
    fixed non-existent path; Path.resolve() doesn't require it to exist."""
    proj = "/repo"
    # (command, expected_outside)
    cases = [
        ("cp /tmp/x README", False),       # bare in-repo dest — the reported gap
        ("mv src /tmp/dest", False),       # bare in-repo source
        ("cp file /tmp/dest", True),       # cp source is read-only; only the dest matters
        ("cp README /tmp/out", True),      # scratch read on a protected branch
        ("cp -t README /tmp/x", False),    # GNU target-first form: the -t operand is the dest
        ("cp -t /tmp/out README", True),   # -t dest outside; README is a read-only source
        ("cp --target-directory=out /tmp/x", False),
        ("cat < README > /tmp/out", True), # input redirect never writes
        ("cat <<EOF > /tmp/out", True),    # heredoc delimiter is not a target
        ("cat <<EOF > README", False),     # …but a bare output target still fires
        ("FOO=1 cp /tmp/x README", False), # env-assignment prefix must not eat the program word
        ("cat /tmp/x > README", False),    # bare redirect target lands in cwd
        ("echo a >> Makefile && touch /tmp/z", False),  # compound form of the same gap
        ("cp /tmp/a /tmp/b 2>&1", True),   # fd dup is not a target
        ("cp /tmp/a /tmp/b 2> /tmp/err", True),  # fd-prefixed redirect, outside target
        ("touch 2 > /tmp/out", False),     # spaced numeric filename is an operand, not an fd
        ("touch 2>/tmp/out", True),        # glued: fd 2, no in-repo target
        ("mkdir foo/bar", False),          # relative path lands in cwd
        ("cp /tmp/x .env", False),         # leading-dot dotfile dest
        ("echo a > README", False),        # in-repo redirect target (no recognized outside path)
        ("cp /tmp/a /tmp/b", True),        # both outside
        ("echo hi > /tmp/out", True),      # echo payload is not a file target
        ("printf x > /tmp/file", True),    # printf payload is not a file target
        ("mkdir /tmp/foo", True),
        ("touch ~/scratch.txt", True),
        ("cp -r /tmp/a /tmp/b", True),     # flag skipped
        ("chmod 0755 /tmp/foo", True),     # numeric mode not a target
        ("chmod +x /tmp/foo", True),       # chmod mode not a target
        ("touch /tmp/a && touch /tmp/b", True),  # compound operator, both outside
        ("git -C /tmp/scratch add README", True),  # git on an outside repo
        ("git add README", False),         # in-repo git mutation (via no-path-token fallback)
        ("touch 123 /tmp/x", False),       # numeric filename IS an in-repo target
        ("mkdir 2026 && cp /tmp/a /tmp/b", False),
        ("cp -t ; touch README /tmp/out", False),  # dangling -t must not leak into the next command
        ("cp -rt README /tmp/x", False),   # -t inside a short-option cluster
        ("cp -rtREADME /tmp/x", False),    # glued cluster value
        ("cp --target README /tmp/x", False),  # abbreviated long option
        ("cp --targ=README /tmp/x", False),
        ("cp -rt /tmp/out README", True),
        ("cp -St /tmp/x README", False),   # -S eats `t` as its suffix; README is the dest
        ("echo x > >(tee /tmp/out)", True),  # process substitution is not a redirect target
        ("echo x > >(tee README)", False),   # …but its inner command still counts
        ("diff <(cat /tmp/a) /tmp/b", True),
        ("mkdir -m 700 /tmp/x", True),     # numeric option value, not a filename
        ("mkdir -pm 700 /tmp/x", True),
        ("mkdir -p 700 /tmp/x", False),    # -p takes no value: 700 is a directory
        ("touch -t 202601011200 /tmp/x", True),
        ("rsync --timeout 30 /tmp/a /tmp/b", True),
        ("cp <(cat /tmp/a) README", False),  # outer operands after a process substitution still count
        ("echo x | tee >(cat > /tmp/b) README", False),
        ("mv <(true) README /tmp/x", False),
        ("cp /tmp/x README > >(cat)", False),  # redirect-target substitution is not cp's dest
        ("cp /tmp/a <(cat) ", True),
        ("(cd /tmp && touch /tmp/a) && touch README", False),
        ("cp -- -t /tmp/out README", False),  # after `--`, -t is a source filename
        ("rm -- -rf", False),              # …and so is anything dash-led
        ("cp -S -t /tmp/x README", False), # -S consumes `-t` as its suffix
        ("cp --suffix -t /tmp/x README", False),
        ("cp -S .bak /tmp/a /tmp/b", True),
        ("echo x >& README", False),       # `>& file` writes the file
        ("ls /tmp/a 2>&-", True),          # fd close
        ("dd if=/tmp/a of=README", False), # dd writes its of= operand
        ("dd if=README of=/tmp/b", True),
        # shlex glues adjacent punctuation into one token; each must still split.
        ("touch README <(cat /tmp/a); true", False),
        ("cp <(cat /tmp/a); touch README", False),
        ("cp <(cat /tmp/a)&& touch README", False),
        ("cp <(cat /tmp/a)|tee README", False),
        ("cp <(cat /tmp/a)>/tmp/o README", False),
        ("tee >(cat)>/tmp/o README", False),
        ("cp <(cat <(cat /tmp/a)) README", False),
        ("cp <(echo $(cat /tmp/a)) README", False),
        ("(true)&&cp /tmp/x README", False),
        ("cp /tmp/a /tmp/b&&touch /tmp/c", True),
        # Quoted/escaped punctuation is a filename, not an operator.
        ("cp /tmp/in ')&&'", False),
        ('cp /tmp/in ")&&"', False),
        ("cp /tmp/in \\;", False),
        ("echo 'a;b' > /tmp/out", True),
        ('echo "x > y" > /tmp/out', True),
        ("find /tmp/x -exec rm /tmp/y {} \\;", True),
        # Newlines and backticks delimit commands too.
        ("true\ncp /tmp/a README", False),
        ("echo `touch README` > /tmp/o", False),
        ("echo `date` > /tmp/o", True),
        # Comments and ANSI-C quotes.
        ("touch /tmp/a#x README", False),  # mid-word `#` is literal
        ("cp /tmp/a /tmp/b # then README", True),  # word-start `#` is a comment
        ("# note\ncp /tmp/a README", False),
        ("echo $'\\'' ; cp /tmp/a README", False),
        ("touch /tmp/a\\ #x README", False),  # escaped space: `#` is mid-word
        ("cp /tmp/a /tmp/../repo/README", False),  # `..` is normalized
        ("cp /tmp/a ~/x.txt", True),
        # Wrappers run the next word as the program.
        ("sudo cp /tmp/a README", False),
        ("sudo -u bob cp /tmp/a README", False),
        ("env -i FOO=1 cp /tmp/a README", False),
        ("nice -n 5 touch README", False),
        ("sudo cp /tmp/a /tmp/b", True),
        # Scratch work that must stay allowed (seatbelt, not a boundary).
        ("cat <<'EOF' > /tmp/pr.md\nIt's a draft.\nEOF", True),
        ('echo "$(date)" > /tmp/o', True),
        ('cp /tmp/a "$HOME/x"', True),
        ("touch /tmp/{a,b}", True),
        ("chmod u=rwx /tmp/x", True),
        ('f=/tmp/x; echo hi > "$f"', True),
        ("OUT=/tmp/out.txt; ls /tmp > $OUT", True),
        ("if (( n > 0 )); then echo x > /tmp/o; fi", True),
        ("echo $(( 1 > 0 )) > /tmp/x", True),
        ("[[ $a > $b ]] && echo x > /tmp/o", True),
        # A command substitution's output is an unknown operand.
        ("cp /tmp/a `printf README`", False),
        ("cp /tmp/a $(printf README)", False),
        ("cp `ls /tmp/a` /tmp/b", True),
        ("touch /tmp/a > `printf README`", False),  # substitution as redirect target
        ("touch /tmp/a > $(printf README)", False),
        ("echo x > >(tee /tmp/o)", True),
        ("touch /tmp/`date +%s`", True),   # glued substitution stays part of the path
        ("mkdir /tmp/x-`date +%s`", True),
        ("cp /tmp/a /tmp/b-`date +%s`", True),
        ("mkdir -p ~/scratch/`date +%F`", True),
        ("rm -rf /tmp/`whoami`", True),
        ("touch /tmp/$(date +%s)", True),
        ("mkdir /tmp/x-`date +%s` README", False),  # outer operands after a glued substitution
        ("touch /tmp/a`date` README", False),
        ("rm -rf /tmp/`whoami` README", False),
        ("touch /tmp/a\\ `date` README", False),
        ("mkdir /tmp/x-$(date +%s) README", False),
        ("echo x > /tmp/x-`date` && ls /tmp", True),
        ("touch ~/n-`date`.txt", True),    # text glued after a substitution stays in the word
        ("echo x | tee /tmp/l-$(date).log", True),
        ("cp /tmp/a /tmp/$(whoami)-`date`", True),
        ("touch /tmp/a`date`b", True),
        ("touch /tmp/a$(b)c$(d)", True),
        ("touch /tmp/`date`README", True),
        ('touch /tmp/$(date)".txt" README', False),
        ("touch $(date)README", False),    # word-start substitution: the whole word is unknown
        ("cp -t $(x) /tmp/a", False),      # substitution as the cp -t destination
        ("cp --target-directory $(x)y /tmp/a", False),
        ("cp -t /tmp/$(x) /tmp/a", True),
        ("case x in a)touch README;; esac; ls /tmp", False),  # case `)` is not a substitution
        ("(cd /tmp)&& touch README", False),
        ("echo $(case x in a) touch README;; esac) > /tmp/o", False),  # case `)` inside a substitution
        ("cp /tmp/a $(case x in x) basename /tmp/README;; esac)", False),
        ("case $x in a) echo hi > /tmp/o;; esac", True),
        ("env -C /tmp touch README", True),   # wrapper cwd is outside
        ("env --chdir=/tmp touch README", True),
        ("env -C sub touch README", False),   # relative wrapper cwd lands in the repo
        ("sudo -D /tmp touch README", True),
        ("rsync --exclude README /tmp/a /tmp/b", True),  # pattern value, not a target
        ("rsync -a --exclude .git /tmp/a README", False),
        ("cp /tmp/a /tmp/out-$(grep -c case /tmp/f).txt", True),  # `case` as a plain word
        ("mkdir /tmp/run-$(echo case)x", True),
    ]
    # Commands the parser handles must also reach it via looks_like_edit.
    edit_cases = [
        ("dd if=/tmp/a of=README", True),
        ("rmdir foo", True),
        ("rsync -a /tmp/a b", True),
        ("shred README", True),
        ("unlink README", True),
        ("npm install", False),
        ("grep -n install package.json", False),
        ("pip install -r requirements.txt", False),
        ("ls -la", False),
    ]
    failures = []
    for command, expected in cases:
        got = _targets_clearly_outside_repo(command, proj)
        status = "ok" if got == expected else "FAIL"
        if got != expected:
            failures.append((command, expected, got))
        print(f"  [{status}] outside={got!s:5} expected={expected!s:5}  {command}")
    for command, expected in edit_cases:
        got = looks_like_edit(command)
        status = "ok" if got == expected else "FAIL"
        if got != expected:
            failures.append((command, expected, got))
        print(f"  [{status}] edit={got!s:5} expected={expected!s:5}  {command}")
    if failures:
        print(f"\n{len(failures)} selftest case(s) failed.")
        sys.exit(1)
    print(f"\nAll {len(cases) + len(edit_cases)} selftest cases passed.")
    sys.exit(0)


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        _selftest()
    main()
