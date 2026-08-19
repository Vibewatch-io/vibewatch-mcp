"use strict";

/**
 * Pure editing logic for Goose's user config (~/.config/goose/config.yaml).
 *
 * Goose has no non-interactive CLI for adding extensions (`goose configure`
 * is a TUI), so connect-buzz edits the YAML directly. The Document API keeps
 * every unrelated key and comment byte-for-byte intact.
 */

const YAML = require("yaml");

const EXTENSION_NAME = "vibewatch";

/**
 * Return the config text with the vibewatch extension entry added or
 * replaced. `envs` carries VIBEWATCH_MCP_KEY / VIBEWATCH_MCP_URL only when
 * the user chose key mode or a non-default server; in OAuth mode it is empty
 * and the bridge reuses the cached sign-in.
 */
function upsertVibewatchExtension(configText, { envs = {} } = {}) {
  const doc =
    configText.trim() === ""
      ? new YAML.Document({})
      : YAML.parseDocument(configText);
  if (doc.errors && doc.errors.length > 0) {
    throw new Error(
      `could not parse Goose config: ${doc.errors[0].message}`
    );
  }
  const entry = {
    enabled: true,
    name: EXTENSION_NAME,
    type: "stdio",
    cmd: "vibewatch-mcp",
    args: [],
    envs,
    timeout: 300,
    description: "Vibewatch community sentiment data (read-only)",
  };
  // A bare `extensions:` key parses as a null scalar, and setIn throws when
  // the intermediate node isn't a collection — drop it so setIn rebuilds it
  // as a map.
  const extensionsNode = doc.get("extensions", true);
  if (extensionsNode !== undefined && !YAML.isCollection(extensionsNode)) {
    doc.delete("extensions");
  }
  doc.setIn(["extensions", EXTENSION_NAME], doc.createNode(entry));
  return doc.toString();
}

module.exports = { EXTENSION_NAME, upsertVibewatchExtension };
