# Pitch

The hackUMBC 2026 pitch for ThreatViz Defend: a 13 slide deck and the talk track that goes with it, about 5 minutes out loud.

[threatviz-defend-pitch.pdf](threatviz-defend-pitch.pdf) is the deck. Slide 5 plays the [click to play demo](../../demo/README.md) in the narrated video; in the PDF it shows the demo's first frame.

## Talk track

1. **Title.** We built ThreatViz Defend: runtime threat modeling while you vibe code.
2. **The problem.** Vibe coding ships apps nobody can explain, and security needs someone who can.
3. **What threat modeling is.** Mapping how a system works, where its data flows and what trusts what, then asking what can go wrong at each step and fixing the worst of it before it ships. We follow the four questions of the Threat Modeling Manifesto, check every part with STRIDE, apply the OWASP Top 10 for LLM applications, and link each threat to CWE ids. NIST's Secure Software Development Framework calls for it, and vibe coding skips it.
4. **Our solution.** A static and runtime threat modeling diagram that makes you aware of what you are vibe coding, finds the threats, and helps you defend against them.
5. **Demo.** Claude Code on the left builds an app. ThreatViz draws the threat model on the right, picks up the new threat when a prompt adds a feature, then coaches the developer until they can defend it.
6. **Runtime threat modeling.** When an agent's turn ends, the hook snapshots the working tree into a private git ref, diffs it against the last report, skips secret files, and posts only architectural changes. The map updates and waits for review. Over MCP the agent can ask the board what a change risks.
7. **Learning that sticks.** Every board ends with up to seven questions about your own system, with answer keys from code. Open answers are graded against the map. The ElevenLabs voice coach talks it through, and Backboard remembers what you missed.
8. **How it is built.** Pasted notes, files, a GitHub URL or a coding agent go through one API that masks secrets, drafts a map, waits for you to confirm it, then finds threats with STRIDE rules and the model.
9. **DigitalOcean.** One App Platform spec runs the API and web app, deploys on every merge to main, and holds Postgres 16 and encrypted secrets. The default model runs on Gradient AI serverless inference.
10. **ElevenLabs.** The voice coach is a private ElevenLabs Agent: speech to text, a coach model, and text to speech, driving the board through four client tools while our server grades. Speech to Text turns a spoken question into text in the ask bar.
11. **Backboard.** A memory store with one private assistant per developer. Before every answer or grade the API recalls the five most relevant notes, then keeps a note of the question and the verdict. Uploads, maps and your answers never go in.
12. **Impact.** Every developer can defend what they ship: threat modeling for everyone, training the defender, keeping up at agent runtime, secure by design.
13. **What's next.** A pull request check that flags a new trust boundary crossing or lethal trifecta before it merges, a team view of who can explain which threats, and private repositories through a GitHub app.

The diagrams on slides 8 to 11 are also in the [README](../../README.md#how-it-is-built) and [docs/services.md](../services.md).

[docs/images/png/](../images/png/) holds PNG copies of every README diagram, dark theme, for sites that cannot show SVG, such as Devpost.
