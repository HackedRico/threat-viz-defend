# User guide

This guide walks through every screen of ThreatViz Defend in the order you meet them: sign up, add material, check the map, read the threats, then defend them. The last sections cover coding agents, model providers, limits and troubleshooting.

## Create an account

You need an invite code from whoever runs the deployment. On a local server the code is `local-dev`.

1. Open the app. The sign in screen has two tabs, **Sign in** and **Create account**.
2. Choose **Create account**.
3. Pick a **Username** of 3 to 24 characters: letters, digits, dots, dashes and underscores, starting with a letter or digit. It is stored in lowercase.
4. Pick a **Password** of at least 10 characters. It must not contain your username or be a common password. **Show** reveals what you typed.
5. Enter the **Invite code**.
6. Choose **Create account**. You are signed in and land on your example board.

To come back later, use **Sign in** with the same username and password. If **Create account** is greyed out with "New accounts are closed right now", the deployment has no invite codes configured.

There is no password reset. If you forget your password, ask the operator to delete the account, then create a new one.

## The sidebar

The left rail holds everything outside the open board.

- **App name.** Goes home, which opens the board you changed most recently. With no boards, home shows "A clean whiteboard." with **Start a board** and **Open the example board**.
- **Collapse sidebar.** The icon beside the name narrows the rail to one letter per board. The app remembers your choice in this browser.
- **Resize sidebar.** Drag the sidebar's right edge to make it wider or narrower, between 200 and 480 pixels. With the edge focused, the arrow keys move it 16 pixels and Home and End jump to the limits. Double click the edge to go back to the default width. The app remembers the width in this browser.
- **New board.** Type a name and choose **Create**, or press Escape to cancel. An empty name becomes "Untitled system".
- **Your boards.** Every board with its status and, once threats are found, its worst severity and threat count. The example board carries an `example` tag. The list refreshes every 15 seconds, so boards a coding agent changes show up on their own.
- **Example board.** Opens the example. If you deleted it, the button reads **Restore the example board** and adds a fresh copy.
- **Connect a coding agent.** Opens the coding agents settings.
- **Account menu.** Your name and today's model calls. Open it for two meters, **Model calls today** and **Voice sessions today**, plus **Connect a coding agent**, **Model provider** and **Sign out**.

Board statuses read the same everywhere:

| Status | Label |
|---|---|
| `empty` | No material yet |
| `mapping` | Drawing the map |
| `review` | Check the map |
| `analyzing` | Finding threats |
| `ready` | Ready to defend |

## The example board

Every new account gets "Example: Inbox Helper", a finished threat model of an AI email assistant. It is ready to explore and quiz on, so it is the fastest way to see what a finished board looks like. In demo mode it is the only system the app can analyze.

## The board header

Across the top of every board:

- **Title.** Click it to rename. Enter or clicking away saves; Escape cancels.
- **Status pill.** The board's status, with a spinner while the server works.
- **Severity badges.** On a ready board, the number of threats at each severity.
- **Analyzed by.** On a ready board, the model that found the threats.
- **Add material.** Opens intake to add more to a board that already has some.
- **Export report.** On a ready board, downloads the threat model as a Markdown file named after the board.
- **Connect an agent.** Opens the coding agents settings with this board picked.
- **Delete.** The trash icon asks "Delete this board?". **Delete** removes the board, its activity and its quiz answers for good. **Keep** cancels.

A red banner, "The last step failed.", appears when drawing the map or finding threats failed. It gives the reason. A grey banner with a dot names the newest activity when the board changes in the background, such as a finished map or a coding agent's change. Dismiss either banner with its close button.

## Add material

An empty board opens on intake: "What are we drawing?". On a board with a map, **Add material** opens it as "What changed?", and the map is updated instead of drawn from scratch.

Good material says who uses the system, what it stores, which services it calls and where the AI parts are. A README, design notes, compose files, infrastructure code, API specs and source code all help.

### Paste text

Give the text a **Name** (it defaults to "Pasted notes") and paste into **Design doc, README or notes**. The counter shows how much of the 200,000 character limit you have used.

### Files and folders

- **Choose files** picks one or more files.
- **Choose a code folder** picks a whole folder and keeps each file's path.
- **Drag and drop** files or folders onto the box. Dropped folders are walked, but never into folders the policy skips, and the walk stops after 20,000 entries.

Picked files are checked by name and size first, and only the ones that pass are read. They appear in a list with their kind, path and size. Documents such as `.md`, `.txt` and READMEs are marked `file`; everything else is `code`. Remove one with its close button, or **Clear** the list.

### What gets skipped, and why

Skipped files are never read and never sent. Open "N skipped, never read or sent" to see each one and its reason.

| Reason | Examples |
|---|---|
| may hold credentials | `.env`, `.env.local`, `.npmrc`, `.netrc`, `id_rsa`, `*.pem`, `*.key`, `*.tfstate`, `*.tfvars`, `secrets.yaml`, `service-account.json` |
| vendored or generated folder | anything under `node_modules`, `.git`, `.venv`, `dist`, `build`, `target`, `vendor` and similar |
| dependency lockfile | `package-lock.json`, `yarn.lock`, `poetry.lock`, `uv.lock`, `go.sum` |
| binary or generated file | images, PDFs, archives, fonts, media, compiled files, databases, `*.min.js`, source maps |
| empty file, binary content | a file with no bytes, or with NUL bytes inside |
| size | over 200 KB for one file, over 400 files, or over 1.5 MB in all |

Example env files such as `.env.example`, `.env.sample` and `.env.template` are kept, because they name settings without values.

The server checks every file again, and replaces anything shaped like a secret (keys, tokens, passwords in URLs or assignments) with `[redacted]` before the model sees it. The activity log says how many values it masked. Only the name and size of each source are kept after the map is drawn; the content is not stored.

### A GitHub repository

Under "Or read a public GitHub repository", paste a URL such as `https://github.com/owner/repo`, or `https://github.com/owner/repo/tree/main` for a branch or tag, and choose **Read repository**. The server downloads the repository and reads its text files with the same rules. Repositories over 30 MB are refused; upload their key folder instead.

### Send it

Choose **Draw the map**, or **Redraw the map** when updating. "Already on this board" at the bottom lists the sources added before.

## While the server works

The board shows a sketch drawing itself, the step it is on, which model is in use, and the sources being read. This usually takes under a minute. You can leave the page; the board keeps working and updates when you return. A map update or threat search on a board that already has a map shows a banner over the map instead, and the side panel shows the activity log.

## Check the map

When the map is drawn, the board goes to **Check the map** and the canvas shows a `draft` stamp. Every threat is pinned to something on this map, so a wrong map gives wrong threats. Check it before you confirm.

### The canvas

| Shape | Means |
|---|---|
| Box with a person | External person or vendor |
| Rounded box | Process your team runs |
| Cylinder | Data store |
| Dashed outline | Trust boundary |
| Arrow | Flow of data |
| Double line | The flow crosses a trust boundary |
| Ring labeled "lethal trifecta" | An AI part that reads sensitive data, takes in untrusted content and can send data out |

The map key sits in the bottom left corner of the board. Fold it to its title when it covers part of the map, and Show brings it back. The zoom, fit and zoom level controls sit in the bottom right corner.

- **Pan:** drag, scroll, or use the arrow keys.
- **Zoom:** pinch, hold Ctrl and scroll, the zoom buttons, or `+` and `-`.
- **Fit:** the fit button or `0`.
- **Select:** click an element, or Tab to it and press Enter. Escape clears the selection.

On an updated map, elements carry a `new` or `edited` tag.

### The inspector

Selecting a node or flow opens a card over the canvas with its id and kind. It always shows the **Evidence** the model cited. Evidence that starts with `inferred:` is shown under "Inferred, not quoted", which means the material did not say it outright.

In review you can edit a node:

- **Name** and **Technology**
- **Kind**: External person or vendor, Process, or Data store
- **Trust boundary**: one of the map's boundaries, or "Outside every boundary"
- **Is or calls an AI model**
- **Holds sensitive data**

For a flow you can edit its **Label** and **What it carries**, and jump to either end.

The node card also lists its flows. **Delete** removes the element, and for a node, every flow that touches it.

### The review panel

On the right:

- **Check the map before threats are found.** The main button reads **Looks right, find threats**, or **Save and find threats** when you have edits.
- **Unsaved edits.** A banner offers **Save changes** and **Discard**. If someone else, such as a coding agent, changed the map while you edited, the banner turns red and warns that saving replaces their version.
- **Changed since the last map.** Elements marked `new`, `edited` or `gone`. Click one to select it.
- **Things to check.** Boundaries, sensitive stores, AI parts and missing flows.
- **What was assumed.** The model's own notes on what was unclear.
- **Everything on the map.** Every node and flow as a clickable list.
- **Activity and sources.**

### Confirm

Choose **Looks right, find threats**. The board goes to **Finding threats**, then **Ready to defend**. The map is read only on a ready board. To change it, use **Add material**: the map is redrawn, the board returns to **Check the map**, and the threats are found again when you confirm.

## Read the threats

A ready board opens centered on the element with the worst threat.

- **The short version.** The sticky note across the top of the canvas explains the board to someone new. Side by side it says what the system is, how many threats were found by severity and what to fix first, with how to read the map underneath. Fold it away with its button; it stays folded on later boards until you open it again.
- **Pins.** Each threat is a numbered pin on its node or flow. The shape shows severity without relying on color: octagon for critical, triangle for high, circle for medium, square for low. Clicking a pin selects its element and opens the threat in the list.
- **Lethal trifecta.** A ring around an AI part. Select it to see "Reads sensitive data from", "Takes untrusted input from" and "Can send data out to".
- **Crossings.** Double lines mark flows that cross a trust boundary; the inspector says "flow, crosses a boundary".
- **Highlights.** When something lights up part of the map, a chip names the source, such as "Lit by the answer", with **Clear**.
- **Hide panel.** The button at the top right of the canvas hides or shows the side panel.
- **Resize panel.** Drag the side panel's left edge to widen it, up to 900 pixels or 60 percent of the window, whichever is smaller. The keys and double click work as they do on the sidebar edge. On a window narrower than 1100 pixels the panel sits under the map at full width and has no edge to drag, and the page scrolls down to it.

### Ask

The ask bar runs along the bottom of the canvas. Ask the analyst a question about this board. If an element is selected, the question is about it; choose **Ask about the whole board** to drop that focus. Type in the box and choose **Ask**, or press Ctrl or Cmd with Enter. Starter questions, which name parts of this board such as its AI part or the store that holds its most sensitive data, fill the box for you until you send your first question. Each question uses one model call. The answer shows above the box as plain text with chips that light the elements it names; **All of them** lights every one, and the close button dismisses it. On a selected element, **Ask about this** in the inspector puts the cursor in the ask bar. Drag the top edge of the ask bar to make it taller or shorter; the answer, or the box when there is no answer, takes the room. The height is remembered in this browser, and a double click on the edge fits the bar to its content again.

The side panel has four tabs.

### Threats

Every threat, worst first, with where it sits, its severity and its STRIDE category. Open a card for the full statement, the impact, "Fixes to start today", catalog references such as CWE or OWASP ids, and the evidence. Opening a card lights its element on the map.

### Paths

Attack paths, worst first, each with its story, its steps in order, and the threats it goes through. Hover or focus a path to light it on the map. Click it to keep it lit; click again to let go. Click a threat id to jump to it.

### Defend

See [Defend what you built](#defend-what-you-built).

### Log

The activity log and the list of sources. See [Activity log](#activity-log).

## Export the report

On a ready board, choose **Export report** in the header. You get a Markdown file with the summary, the verdict, a table of components and flows, the lethal trifecta, every threat with its fixes and evidence, the attack paths and the assumptions. Model text in it is escaped, so it shows as plain text in any Markdown viewer.

## Defend what you built

The **Defend** tab checks that you can explain your own system.

### Mastery

The top shows your score as a percent, how many questions you answered, how many were right and how many partly right. Right counts fully and partly right counts half. **Weak spots** lists the elements behind every answer that was not fully right; click the heading to light them all, or a chip to light one.

### The text quiz

Choose **Type answers**. The numbered stops across the top are the questions, marked by how each went; click one to jump to it. There are up to 7:

1. **Trust boundaries.** Which flows cross a trust boundary.
2. **Sensitive data.** Which components receive data from a sensitive store.
3. **Where it breaks.** Where on the map the worst threat happens.
4. **STRIDE.** What kind of threat another top threat is.
5. **Lethal trifecta.** Which flow would break it, or which parts give the AI a way out.
6. **Attack path.** In your own words, the path something malicious takes and the harm it does.
7. **The fix.** In your own words, one concrete change that stops the worst threat.

A question is left out when the map has nothing for it to ask about, such as a map with no AI parts.

For choice questions, pick one option or every one that applies, then **Submit answer**. Code grades these. For the two open questions, write your answer; a model grades it in a few seconds and it uses one model call.

The result shows:

- A stamp: **Correct**, **Partly right** or **Not quite**.
- For choice questions, every option marked `yes`, `missed` or `no`.
- For open questions, your own words.
- Feedback, then the explanation.
- **From the material**: the evidence quotes behind the answer.
- **Next question**, **Show on the map** to light the answer, and **Try again**.

**Start the quiz over** at the bottom forgets every answer on this board. The quiz also starts over on its own when the threats are found again, because the questions are rebuilt from the new threat model.

### The voice coach

When the server has voice set up, **Talk it through** runs the same quiz out loud. If it is greyed out, the page says the quiz is text only on this server.

1. Choose **Talk it through**, then **Start talking**. Your browser asks for the microphone first; if you refuse, nothing is spent.
2. The coach asks each question out loud. Answer choice questions by saying letters, such as "A and C". Answer open questions in your own words.
3. The current question and its options stay on screen, with the coach's feedback once graded. The transcript shows what you both said.
4. Choose **Stop** to end the call. Leaving the panel also ends it.

Each start uses one voice session; the hint under the button says how many you have left today. Answers are graded by the same server as the text quiz, so switching between typing and talking loses nothing. If the voice service fails, **Use the text quiz** switches back.

## Activity log

Open **Activity and sources** in the review panel, or the **Log** tab on a ready board. It lists what happened, with times: material added and how many values were masked or files skipped, maps drawn, hand edits, confirmations, threats found, coding agent changes and failures. Below it are the sources, by name, kind and size. The log shows the newest 40 events.

## Connect a coding agent

Open **Connect a coding agent** from the sidebar, the account menu or a board header.

1. **Make a personal token.** Give it a name such as "Laptop Claude Code" and choose **Create token**. Copy it right away; it is shown once and never again. The table below lists your tokens by name, first characters, creation time and last use. **Revoke** stops a token at once. You can hold up to 10.
2. **Add the server to your agent.** Copy the ready-made **Claude Code** command, or the **Cursor** `.cursor/mcp.json` file plus the `export THREATVIZ_TOKEN=...` line for the shell that starts Cursor. The token fills in once you create it. The MCP endpoint is shown too.
3. **Tell the agent which board.** Pick a board and copy its id; the agent's tools take it.

Once connected, the agent can list and read your boards, ask about them, report changes it makes, and quiz you in the editor. Each reported change redraws the map and waits in **Check the map** for you. [integrations/README.md](../integrations/README.md) covers the tools and the hook that reports each turn's changes on its own.

## Choose a model provider

Open the account menu and choose **Model provider**. Maps, threats, answers and open quiz grading all run on a language model.

**In use now** names the model analyzing your boards: your own model, the server's default model, or demo mode.

To use your own:

1. Pick a **Kind**:
   - **OpenAI compatible**: OpenAI, DigitalOcean, OpenRouter, Ollama and other services that speak the Chat Completions API.
   - **Backboard**: many models through one key, with optional memory.
2. Choose a preset to fill the **Base URL** and suggest a model: OpenAI, DigitalOcean, OpenRouter or Ollama, or Backboard. Or type your own base URL.
3. Enter the **Model**. Backboard models are written as `provider/model`, such as `openai/gpt-4o`.
4. Paste the **API key**. Local services such as Ollama may need none. Once saved, the key is never shown again; leave the field empty to keep it.
5. For Backboard, turn on **Remember my progress across boards** if you want memory.
6. Choose **Test connection**. It checks the address and the key and lists the models the service offers; click one to use it. Nothing is saved yet.
7. Choose **Save**. New analyses run on your model, and each board names the model that analyzed it.

**Remove and use the server default** forgets your provider and key.

Base URLs must use https and point at a public address. The Ollama preset uses `localhost`, which means the server's own machine, so it only works where the server allows private addresses, such as a local development server.

**What memory does.** With memory on, Backboard keeps what you asked the analyst and how your quiz answers went, and uses it in later answers and grading, across boards. Drawing maps and finding threats only read memory, so your uploaded material is never written into it.

Calls on your own key do not count against the daily allowance, only against the limit of 6 model calls per minute.

## Usage limits

The account menu shows what you have used today. Allowances reset at midnight UTC. The defaults are below; a deployment may set others.

| Limit | Default |
|---|---|
| Model calls per day on the server's model | 60 |
| Model calls per minute, any model | 6 |
| Voice sessions per day | 10 |
| Boards | 30 |
| Personal tokens | 10 |
| Coding agent changes per hour | 30 |

These each use one model call: drawing or updating a map (from notes, files, GitHub or a coding agent), finding threats, asking a question, and grading an open quiz answer. Choice questions are free. A step that fails still counts.

The whole deployment also has a shared daily limit. When it runs out, everyone waits for midnight UTC unless they use their own provider.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "That invite code is not valid." | Check the code with the organizers. Codes are exact. |
| "This account is locked for 15 minutes after repeated failed sign ins." | Five wrong passwords lock the username. Wait 15 minutes, then sign in. |
| "Sign ups are closed: this event has reached its account limit." | The deployment is full. Ask the operator. |
| You are sent back to the sign in screen | Your session expired or was ended. Sign in again. |
| "Demo mode can only map the built-in examples" | The server has no model. Save your own under **Model provider**, or explore the example board. |
| "None of those files can be sent. See the skipped list for why." | Every file was skipped. Open the skipped list, then add docs or source files instead. |
| "Everything together must stay under 1.5 MB." | Remove files, or pick a smaller folder such as the service you care about. |
| "Nothing readable was sent: every file was empty or skipped." | Same as above, checked on the server. |
| A GitHub import fails with "GitHub has no public repository or ref" | The repository is private or the URL is wrong. Upload the folder instead. |
| A GitHub import fails with "over 30 MB" | Upload the repository's key folder instead. |
| "The board is already working." | A map or threat job is running. Wait for the status to settle. |
| "found no components in that material" | The material did not describe a system. Add a README, design notes or source code. |
| "returned data in the wrong shape twice" or "ran out of output tokens" | The model struggled. Try again with less material, or pick a stronger model. |
| "rejected the API key" | Fix the key under **Model provider**, or remove your provider. |
| "The base URL points at a private or local address" | This server only calls public addresses. Use a public endpoint. |
| "A saved API key could not be decrypted" | The server's secret changed. Save your provider again with the key. |
| "You have used today's 60 model requests." | Wait for midnight UTC, or use your own provider. |
| "You are asking the model very quickly." | Wait a minute. |
| "The server restarted while this was running." | Run the step again: add the material again, or confirm again. |
| The quiz says a question is out of date | The board changed. Reload the quiz. |
| **Talk it through** is greyed out | The server has no voice coach. Use the text quiz. |
| "Microphone access is blocked." | Allow the microphone in the browser's site settings, then start again. |
| "No voice sessions left today." | Use the text quiz until midnight UTC. |
| A coding agent gets 401 | The token was revoked or mistyped. Create a new one. |
| A coding agent's change does not show | The board may have been busy; the change is retried or refused with a message. Check the board's activity log. |
