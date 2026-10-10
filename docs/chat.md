# Chat companion

The chat companion is a local language model that you talk to in the Embernest web
app, on your computer or your phone. It runs on your machine through llama.cpp. Your
messages do not leave the computer, except a web search query when you turn search on
for a chat (see [Search](#search)).

- [Turn it on](#turn-it-on)
- [Models](#models)
- [Think harder](#think-harder)
- [Speed and the benchmark](#speed-and-the-benchmark)
- [CPU or GPU](#cpu-or-gpu)
- [Personas](#personas)
- [Memory and incognito](#memory-and-incognito)
- [Search](#search)
- [Images from chat](#images-from-chat)
- [Where the data lives](#where-the-data-lives)
- [Commands](#commands)

## Turn it on

Chat is optional. Add it during setup, or turn it on later:

```sh
embernest setup --chat                  # setup installs the chat engine and a model
embernest setup --chat-model qwen3-4b   # the same, with a model you pick
embernest setup --chat-think            # also add the Think harder model
embernest chat enable                   # later, on an existing install
embernest chat enable --model llama32-3b --yes
embernest chat disable                  # turns it off and keeps the downloaded files
embernest setup --no-chat               # setup without chat, and chat turned off
```

In an interactive `embernest setup`, Embernest asks "Add a chat companion?" and shows
the download size. Chat needs the llama.cpp engine (downloaded for your hardware) and
one model file. When chat is on, `embernest start` also starts the chat engine on
`127.0.0.1:8189`, which only this computer can reach.

Changing the model or the device needs a restart: `embernest stop && embernest start`.

## Models

Every chat model has one **role**. The role decides which one is the default and which
one "Think harder" uses:

- **fast**: 1–2B models, the default on a CPU with less than 24 GB of RAM.
- **balanced**: 3–14B models, the default on a GPU and on bigger CPU machines.
- **think**: a reasoning model for tricky questions, used only when you press 🧠 (see
  [Think harder](#think-harder)).

These are the chat models pinned in the install manifest. Sizes are the download size
of the model file.

| Id | Model | Role | Variant | Download | Size class |
|---|---|---|---|---|---|
| `qwen25-1b5` | Qwen2.5 1.5B Instruct | fast | mainstream | 1.1 GB | 1-3B |
| `qwen25-1b5-abliterated` | Qwen2.5 1.5B Instruct abliterated (uncensored) | fast | uncensored | 1.0 GB | 1-3B |
| `llama32-3b` | Llama 3.2 3B Instruct | balanced | mainstream | 2.0 GB | 1-3B |
| `llama32-3b-abliterated` | Llama 3.2 3B abliterated (uncensored) | balanced | uncensored | 2.2 GB | 1-3B |
| `qwen3-4b` | Qwen3 4B Instruct 2507 | balanced | mainstream | 2.4 GB | 3-4B |
| `qwen3-4b-abliterated` | Qwen3 4B Instruct 2507 abliterated (uncensored) | balanced | uncensored | 2.4 GB | 3-4B |
| `qwen25-7b` | Qwen2.5 7B Instruct | balanced | mainstream | 4.6 GB | 7-8B |
| `qwen25-7b-abliterated` | Qwen2.5 7B Instruct abliterated v2 (uncensored) | balanced | uncensored | 4.6 GB | 7-8B |
| `qwen25-14b` | Qwen2.5 14B Instruct | balanced | mainstream | 8.8 GB | 12-14B |
| `qwen25-14b-abliterated` | Qwen2.5 14B Instruct abliterated v2 (uncensored) | balanced | uncensored | 8.8 GB | 12-14B |
| `qwen3-4b-thinking` | Qwen3 4B Thinking 2507 | think | mainstream | 2.4 GB | 3-4B |
| `qwen3-4b-thinking-abliterated` | Qwen3 4B Thinking 2507 abliterated (uncensored) | think | uncensored | 2.4 GB | 3-4B |

- **Mainstream** models are the standard instruction-tuned releases.
- **Uncensored** models are "abliterated" versions with their refusals removed. The
  fixed rules in the persona preamble still go in front of every chat, but an uncensored
  model may ignore them. See [ACCEPTABLE_USE.md](../ACCEPTABLE_USE.md).

`embernest chat models` lists the models for this machine, sorted fast, balanced, then
think. It shows each model's role, its size, whether it fits in memory and whether it is
installed. Balanced models are shown only for this machine's size class and the one above.

Select a model with `embernest chat use <id>`. A model that is not installed yet is
downloaded first. Only ids from the list above can be used; bringing your own GGUF file
is not supported yet.

Tool calling (used for web search and images) is enabled for every model in the list.
Think harder replies do not use tools.

## Think harder

Think harder is a per-message option. A reasoning model answers one message, and the
next message goes back to the default model.

- **Set it up**: `embernest chat think enable` (or `--model <id>` for one of the think
  models in the table). Setup can add it too: `embernest setup --chat-think`. Use
  `embernest chat think use <id>` to pick another think model (it is downloaded first if
  missing), and `embernest chat think disable` to turn it off. Files are kept.
- **Use it**: press the **🧠 Think harder** chip under the message box. The button lights up for the next message only. It
  is shown only when a think model is set.
- **What you see**: a "Thinking… (N s)" block that streams the reasoning in dimmed text.
  When the answer starts, the block collapses to "Thought for N s". Open it to read the
  reasoning.
- **What is kept**: only the final answer is saved, with a "Thought for N s" note. The
  reasoning is not saved and never goes into later prompts.
- **How long it takes**: the reasoning comes first, so Think harder is much slower than
  the default model. In a check on the test machine (chat on the CPU, 15.5 GB RAM), a
  short factual question started its answer after about 65 seconds, while the default
  model's first word for another short question came after about 6 seconds.

## Speed and the benchmark

Reply speed depends mostly on the model size and on how much of the prompt the engine
has to read again on each turn.

- **Why fast is the default.** In the benchmark on the test machine (chat on the CPU),
  the fast model's first token took about 0.3 to 0.4 seconds and a 4B balanced model's
  about 1 second. Bigger models are slower, so measure your own machine with the
  benchmark below. On a machine with 24 GB of RAM or more, or a GPU, the default is
  balanced.
- **Prompt cache.** The start of each prompt (the persona, the date and the chat so far)
  stays the same from turn to turn, so llama.cpp can reuse what it already read. Recalled
  memories are put into your latest message, not the start. Turns after the first are
  therefore faster. The per-reply log line shows `cached_tokens`.
- **Switching models** can lose that cache. The engine keeps two models loaded only when
  a think model is set and the machine has 16 GB of RAM or more. Otherwise it keeps one,
  so the first reply after a Think harder reply reads the whole prompt again.

`embernest chat bench` measures this on your machine:

```sh
embernest chat bench          # a table: first token on each of two turns, speeds, verdict
embernest chat bench --json   # the same as JSON
```

For each installed chat model it sends a fixed two-turn conversation. The first token
time and the speeds are reported per model. The verdict is **fast enough for chat** when
the second turn generates at least 8 tokens per second and its first token comes within
3 seconds. A think model's first token is its first reasoning token, so it is marked
"reasons before it answers" instead.

- **Running**: the benchmark uses the running chat engine. The engine loads only the
  default model and the think model, so any other installed model is skipped, and the
  output says so. Stopping Embernest and benchmarking then tests every installed model.
- **Stopped**: Embernest starts a temporary chat engine on a free port, benchmarks every
  installed model, and stops the engine again, even when the benchmark fails.

## CPU or GPU

`embernest chat device` sets where the model runs:

- `auto` (default): the GPU when it has more than 8 GB of VRAM (or unified memory on
  Apple Silicon, counted the same way as for images), otherwise the CPU.
- `cpu`: always the CPU.
- `gpu`: always the GPU.

```sh
embernest chat device gpu     # on a big GPU, for faster replies
embernest chat device cpu     # free the GPU memory for image generation
```

**On a GPU with 8 GB of VRAM or less, chat runs on the CPU by default.** Replies on a
laptop CPU can be slow with a big model. A fast-role model (`qwen25-1b5`) is the
quickest way to speed that up, and `embernest chat bench` shows the numbers for your
machine.

Chat and image generation share the same GPU when chat runs on it. Another program that
uses the GPU, such as another local LLM, can also take the memory. Image generation can
then fail with an out-of-memory error. Use `embernest chat device cpu`, close the other
program, or use a smaller model. See [troubleshooting](troubleshooting.md#chat).

## Personas

A persona is a character: a name, avatar, tagline, personality, speaking style, a
greeting and example dialogue. Create, edit and delete personas in **Chat**: tap **+ New chat** to pick one, then **Edit** on the persona card (or tap the name in the chat header). Chats
without a persona use a plain assistant.

Every persona gets the same fixed preamble first. It says that the character is an
adult, that the model must never produce sexual content involving minors, and that it
must never sexualise real, identifiable people. The persona's own text cannot change or
override those rules.

## Memory and incognito

With a persona, Embernest can remember lasting facts about you (preferences, people in
your life, plans) and bring the relevant ones into later chats with that persona.

- **What is stored.** Short sentences about you, kept per persona. The extraction is told
  to skip small talk, the assistant's own words, fiction and secrets such as passwords or
  card numbers. Memories are capped at 200 per persona.
- **When it runs.** After four new messages from you pile up, or ten minutes after the
  last reply. It runs in the background and does not slow the reply.
- **How it is used.** Pinned memories are always included. Other memories are included
  when their words match your recent messages. Ties go to the newest memory.
- **You stay in control.** The **Memories** section of the persona editor lists them (open it with **Persona & memories** in the chat's ⋮ menu). You can add a
  memory, pin or edit one, delete one, or choose "Forget everything".
- **Incognito.** Turn on **Incognito** in the chat's ⋮ menu for a chat that neither reads nor
  writes memory. Chats without a persona have no memory at all.

## Search

Web search is **per message**, like Think harder and Image. Press the **🔎 Search** chip
under the message box, then send: that one message is searched on the web. The chip turns
itself off after sending, so nothing is searched unless you press it again.

With search on, the server searches the web with your text before the companion answers,
and the results go into its context. Search can be combined with 🧠 Think harder: the
results are added and the think model answers. 🎨 Image wins over Search: with both chips
on, the message makes an image and no search runs.

Older chats may still carry a per-chat search setting from before this change. It is
ignored. Only the search terms leave your computer, and they go to the provider
named in the button's tooltip. The companion gets up to 5 results (title, link and a short
snippet). It does not open the result pages. Sources appear as chips under the reply,
showing the site name. Each chip opens the page in a new tab.

- **DuckDuckGo** is the default provider. DuckDuckGo sometimes blocks automated searches.
  When that happens the search fails and the companion answers without the results.
- **SearXNG** is the reliable option. It is a search service that you run yourself or
  use from a trusted host. Set its address in the app under **Settings → Chat search**,
  for example `https://search.example.org`. Leave the field empty to use DuckDuckGo. The
  address must start with `http://` or `https://`. Your SearXNG instance must allow the
  JSON output format (`format=json`), which it uses for the results.

A search gives up after 8 seconds. The companion then answers without the results.

## Images from chat

When the image engine is running (see [the main README](../README.md)), the companion can
make an image from a request, for example "draw a lighthouse at dusk". It uses the
default settings for your hardware, waits up to two minutes, and shows the progress in the
chat. The image appears under the reply. Tap it to open it at full size.

Images made from chat are not checked by the nudity classifier. The rules in
[ACCEPTABLE_USE.md](../ACCEPTABLE_USE.md) apply.

## Where the data lives

Everything is in the data folder (see [the main README](../README.md#where-things-live)):

| Folder | What it holds |
|---|---|
| `<home>/chat/conversations/` | Saved chats, one file each |
| `<home>/chat/personas/` | Your personas |
| `<home>/chat/avatars/` | Avatar images you uploaded |
| `<home>/chat/memory/` | Memories, per persona |
| `<home>/llm/` | The llama.cpp engine and the chat model files (`models/`) |
| `<home>/config.json` | Chat settings, including the SearXNG address (no secrets are printed) |

To delete all chat history, memories and personas, stop Embernest and delete `<home>/chat`.
To delete the chat model files too, delete `<home>/llm`.

## Commands

| Command | What it does |
|---|---|
| `embernest chat enable [--model <id>] [--yes]` | Install the engine and a model (if needed), then turn chat on |
| `embernest chat disable` | Turn chat off. Files are kept. |
| `embernest chat models` | List the models for this machine, with role, fit and installed columns |
| `embernest chat use <id>` | Select a model; it is downloaded first if missing |
| `embernest chat device <auto\|cpu\|gpu>` | Choose where the model runs |
| `embernest chat bench [--json]` | Time each installed model (see [Speed and the benchmark](#speed-and-the-benchmark)) |
| `embernest chat think enable [--model <id>] [--yes]` | Install a think model (or the suggested one) and turn Think harder on |
| `embernest chat think use <id>` | Select an installed think model; it is downloaded first if missing |
| `embernest chat think disable` | Turn Think harder off. Files are kept. |
| `embernest logs` | The server log, which has one `chat reply:` line per reply (model, prompt tokens, cached tokens, first token time, tokens per second) |
| `embernest logs chat` | Show the last lines of the chat engine log (`-f` to follow, `-n` for count) |

Setup also takes `--chat`, `--chat-model <id>`, `--chat-think`, `--no-chat-think`,
`--chat-think-model <id>` and `--no-chat`. Run
`embernest chat <command> --help` for the options.

The HTTP routes behind the Chat section are listed in [api.md](api.md#chat).
