// System-prompt section teaching the model about the OpenViking context
// database available in this session: what it is, which tools to use, and
// when recall is injected automatically.
const SECTION_BODY = `## OpenViking context database

This session has an OpenViking context database available (viking:// URIs, tiered L0/L1/L2 content).

- Relevant memories are injected automatically before each user turn; you do not need to search for them again in the same turn.
- To find more context on demand, use openviking_search (semantic) or openviking_find (fast), then openviking_read to load content.
- openviking_list shows what context exists under a viking:// directory (resources, memories, skills).
- When the user states personal preferences, facts, or experience worth keeping, call openviking_remember to store it in long-term memory.
- Prefer OpenViking tools over local filesystem reads of viking:// URIs; local reads of those URIs are denied.`;

/**
 * Register the OpenViking system-prompt section.
 *
 * @param {object} ctx - the plugin's Cordis context (requires `systemPrompt`).
 */
export function installPromptSection(ctx) {
  ctx.systemPrompt.section({
    name: "openviking",
    order: 150,
    text: SECTION_BODY,
  });
}
