# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

Use GitHub Security Advisories: on the repository page, open **Security**, then
**Report a vulnerability**. Include the Embernest version (`embernest --version`),
your OS, the steps to reproduce, and what you expect to happen. Do not include
your `config.json`, tokens or pairing links.

Please give us time to fix the problem before you publish details.

## Threat model

Embernest is built for one person running it on their own computer and using it
from their own devices.

What it protects against:

- **Other devices on your network.** Every request from outside this computer
  needs a token (or the pairing cookie). The Host header is checked, which blocks
  DNS rebinding. State-changing requests from other websites are refused.
- **Brute-forcing the token.** Failed attempts are rate limited per address.
- **Direct access to the image engine.** ComfyUI is started by Embernest and
  bound to `127.0.0.1`. The only network-facing server is Embernest's.
- **Secrets in logs and output.** Tokens are read from `config.json` (mode 0600)
  and sent only to the provider's own host. The CLI prints them only as "set" or
  "not set".
- **Unsafe edits of real people's photos.** See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

What it does not protect against:

- **Anyone with the token**, or with access to your user account on the computer.
- **Malicious models, LoRAs or custom nodes.** Some model formats (such as pickle
  `.ckpt` files) can run code when loaded. Prefer `.safetensors` and install only
  from sources you trust.
- **Exposure you add yourself.** Setting `listenOnLan` or running `tailscale serve`
  or a reverse proxy makes Embernest reachable from more places. Pairing, the token
  and the Host check still apply.

## Telemetry

Embernest sends no telemetry and no analytics. It contacts the network only to
install or update the engine and models, to search the model sites you use, and
to download files you ask for.
