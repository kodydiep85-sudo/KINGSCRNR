# Kings Corner

Card game website. Friends play online, each on their own phone or computer, with a 4-letter game code. You can also play against the computer.

Only 3 files matter:

| File | What it is |
|---|---|
| `index.html` | The game page |
| `server.js` | The game server |
| `package.json` | Tells Render how to start it |

`render.yaml` and this README are optional.

## 1. Upload to GitHub

1. On github.com, create a **new repository**.
2. Click **uploading an existing file** (or **Add file → Upload files**).
3. Drag in `index.html`, `server.js`, `package.json` (and `render.yaml`, `README.md`).
   - Drag the **files**, not the folder and not the zip.
   - All files must sit at the **top level** of the repository.
4. Click **Commit changes**.

## 2. Deploy on Render

1. On render.com click **New → Web Service**. Do **not** pick Static Site.
2. Pick your GitHub repository.
3. Settings:
   - **Language:** Node
   - **Root Directory:** leave **empty**
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Click **Deploy Web Service**.
5. When the log shows `Kings Corner is running on port ...`, open the link at the top of the page.

## If something goes wrong

| What you see | Fix |
|---|---|
| Render log: `Could not read package.json` / `ENOENT ... package.json` | The files are inside a folder in your repo. Move them to the top level, or set **Root Directory** in Render to that folder's name. |
| Render log: `index.html was not found next to server.js` | Upload `index.html` to the same place as `server.js`. |
| Page says *Online play needs the game server* | You made a Static Site. Make a **Web Service** instead (step 2). |
| Page says *Online play only works from the website link* | You opened the file on your computer. Use the Render link. |
| Site takes up to a minute to open | Normal on Render's free plan after 15 minutes with no visitors. Unfinished online games are cleared when it sleeps. |

## Play with friends

1. Everyone opens the Render link.
2. One person types their name and taps **Host a game**.
3. Friends type their name and the 4-letter code, then tap **Join** (2–4 players).
4. The host taps **Start game**.

If someone closes the page, the game plays for them until they come back and tap **Rejoin** on the same device.
