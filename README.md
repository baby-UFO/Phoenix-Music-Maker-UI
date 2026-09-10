# Phoenix Music Maker UI



**Local-first AI music studio** — generate full songs with vocals, edit audio, extract stems, and manage a library in a Spotify-style interface. Runs on your machine.



| | |

|---|---|

| **Repo** | [baby-UFO/Phoenix-Music-Maker-UI](https://github.com/baby-UFO/Phoenix-Music-Maker-UI) |

| **Product** | Phoenix Music Maker |

| **Engine** | Phoenix Engine (local Gradio music backend) |

| **Stack** | React 18 · TypeScript · Tailwind · Vite · Express · SQLite |



---



## Why Phoenix Music Maker?



Build music privately on your own GPU — no subscription queue, no cloud lock-in.



| | Typical cloud music apps | Phoenix Music Maker |

|---|---|---|

| Cost | Monthly subscription | Free to run locally |

| Privacy | Uploaded to the cloud | Stays on your machine |

| Ownership | Platform licenses | You keep your tracks |

| Limits | Credits / queues | Unlimited local jobs |



---



## Features



### Generation

- Full songs with vocals and lyrics (multi-minute)

- Instrumental mode

- Custom BPM, key, time signature, duration

- Style / caption prompts, batch and bulk queue

- Reference audio, cover, and section repaint

- Seed control and inference-step tuning



### Studio UI

- Dark/light Spotify-inspired layout

- Bottom player with progress

- Library, likes, playlists

- LAN access from other devices on your network



### Built-in tools

- Audio editor (trim / fade / effects)

- Stem separation (Demucs)

- ffmpeg export (Original, WAV, MP3, FLAC, OGG)

- Music video helper + gradient covers



---



## Requirements



| Requirement | Notes |

|---|---|

| Node.js | 18+ |

| Python | 3.10+ (3.11 recommended), or a Windows portable engine package |

| NVIDIA GPU | 4GB+ VRAM (12GB+ recommended for LLM / Thinking features) |

| FFmpeg | Audio processing and format export |

| uv | Recommended for standard Python engine installs |



---



## Quick start (Windows)



Your usual layout:



- UI: E:\ace-step (this repo — Phoenix Music Maker UI)

- Engine: E:\ACE-Step-1.5 (Phoenix Engine install folder)



`atch

cd E:\Phoenix-Music-Maker-UI

start-all.bat

`



That starts Phoenix Engine API + backend + frontend.



If the engine lives elsewhere:



`atch

set ACESTEP_PATH=C:\path\to\your-engine

start-all.bat

`



Manual (two terminals):



`atch

REM Terminal 1 — Phoenix Engine

cd E:\ACE-Step-1.5

python_embeded\python -m acestep --port 8001 --enable-api --backend pt --server-name 127.0.0.1



REM Terminal 2 — Phoenix Music Maker UI

cd E:\Phoenix-Music-Maker-UI

start.bat

`



Open **http://localhost:3000** (LAN: http://YOUR_IP:3000).



---



## Quick start (Linux / macOS)



`ash

cd Phoenix-Music-Maker-UI

export ACESTEP_PATH=/path/to/your-engine   # optional; default ../ACE-Step-1.5

./start-all.sh

`



Stop with ./stop-all.sh.



---



## Installation



### 1. Phoenix Engine



**Windows portable package (easiest):** download and extract a local Gradio engine build (e.g. under E:\ACE-Step-1.5 / C:\ACE-Step-1.5) that includes an embedded Python runtime.



**Standard install:**



`ash

# Clone / install your local Phoenix Engine (Gradio music backend)

# Example path name kept for compatibility with existing scripts:

git clone https://github.com/ace-step/ACE-Step-1.5 ACE-Step-1.5  # folder name; product label is Phoenix Engine

cd ACE-Step-1.5

uv venv

uv pip install -e .

`



Start with API enabled on port **8001** before launching the UI.



### 2. Phoenix Music Maker UI (this repo)



`ash

git clone https://github.com/baby-UFO/Phoenix-Music-Maker-UI.git

cd Phoenix-Music-Maker-UI

`



**Windows:** setup.bat  

**Linux/macOS:** ./setup.sh



Or manually:



`ash

npm install

cd server && npm install && cd ..

cp server/.env.example server/.env   # Windows: copy server\.env.example server\.env

`



---



## Configuration



Edit server/.env:



`env

PORT=3001



# Phoenix Engine Gradio URL (must match the engine --port)

ACESTEP_API_URL=http://localhost:8001



DATABASE_PATH=./data/acestep.db



# Optional: Pexels API for video backgrounds

PEXELS_API_KEY=

`



> Env keys like ACESTEP_* are legacy names kept for compatibility with existing scripts. In the product UI they are labeled **Phoenix Engine**.



---



## Usage tips



| Mode | What it does |

|---|---|

| Simple | Describe the track; the engine fills in the rest |

| Custom | Full lyrics + style + BPM / key / duration |

| AI Enhance | LLM enriches tags into a richer caption (+BPM/key/time) |

| Thinking | Heavier LLM reasoning; slower, needs more VRAM |



Keep **batch size at 1** on 8GB GPUs. Prefer **PT** backend on smaller cards; leave Thinking off under ~12GB VRAM.



---



## Troubleshooting



| Issue | Fix |

|---|---|

| Engine not reachable | Start Phoenix Engine with --enable-api on the URL in .env |

| CUDA OOM | PT backend, batch size 1, shorter duration, Thinking off |

| Genre drifts / ballad bias | Turn on **AI Enhance** in Style |

| Downloads wrong extension | Use the in-app format picker (Original / WAV / MP3 / FLAC / OGG) |

| Duration shows 0:00 | Install FFmpeg and ensure it is on PATH |

| LAN blocked | Allow ports 3000 and 3001 through the firewall |



---



## Development



`ash

git clone https://github.com/baby-UFO/Phoenix-Music-Maker-UI.git

cd Phoenix-Music-Maker-UI

npm install && cd server && npm install && cd ..

`



Primary remote for this project: **aby-UFO/Phoenix-Music-Maker-UI**.  

Do not treat third-party upstream UI repos as the home for this product.



---



## Credits



- **Phoenix Music Maker UI** — product UI and local studio workflow ([baby-UFO/Phoenix-Music-Maker-UI](https://github.com/baby-UFO/Phoenix-Music-Maker-UI))

- **Phoenix Engine** — local Gradio music generation backend used by this app

- [AudioMass](https://github.com/pkalogiros/AudioMass) — web audio editor

- [Demucs](https://github.com/facebookresearch/demucs) — stem separation

- [Pexels](https://www.pexels.com) — optional stock video backgrounds



---



## License



MIT — see [LICENSE](LICENSE).



---



**Phoenix Music Maker** — local music, your machine, your tracks.

