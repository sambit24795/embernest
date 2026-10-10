# Using Embernest on your phone

Embernest runs on your computer. Your phone talks to it over your Wi-Fi, or
over a private Tailscale network when you are away from home.

## 1. Same Wi-Fi (the usual way)

1. On the computer, start Embernest: `embernest start`. LAN access is on by
   default (`embernest config set listenOnLan false` turns it off).
2. Scan the QR code from `embernest pair` with the phone camera. The phone
   opens the app and is signed in. The pairing is a cookie on the phone.
3. Sign out a phone from **Settings → Phone & devices → Sign out this device**. To sign out
   every phone at once, run `embernest pair --rotate`; then pair again.

A phone that has not been paired sees a "Pair this device" card. Paste the
access token there, or scan the QR code again.

If the phone cannot connect, allow the port through the computer's firewall
(the default port is 3000; change it with `embernest config set port <n>`):

- **Linux (ufw):** `sudo ufw allow 3000/tcp`
- **Linux (firewalld):** `sudo firewall-cmd --add-port=3000/tcp --permanent && sudo firewall-cmd --reload`
- **Windows:** allow Node.js through Windows Defender Firewall on Private networks, or run in an administrator PowerShell:
  `New-NetFirewallRule -DisplayName "Embernest" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow`
- **macOS:** System Settings → Network → Firewall → Options, and allow incoming connections for Node.

Use the **same Wi-Fi** as the computer. Guest or "client isolation" networks
block phones from reaching the computer.

## 2. Away from home (Tailscale)

[Tailscale](https://tailscale.com) gives your computer and phone a private
address on your own network. Nothing is opened to the internet, and it gives
you HTTPS, which the installable app and offline mode need.

1. Install Tailscale on the computer and on the phone, and sign in to the same account.
2. On the computer, expose Embernest to your tailnet over HTTPS:

   ```sh
   tailscale serve --bg 3000
   ```

   This prints an address like `https://<pc>.<tailnet>.ts.net`.
3. On the computer, make the pairing QR code point at that address:

   ```sh
   embernest pair --url https://<pc>.<tailnet>.ts.net
   ```

   Scan it with the phone while it is on Tailscale. The app opens at the
   `ts.net` address. Embernest accepts `*.ts.net` host names by default.

To stop sharing, run `tailscale serve --https=443 off` (or `tailscale serve reset`).

## 3. Install it on the home screen

Open the app in the phone browser, then choose **Add to Home Screen** (iPhone
Safari: Share → Add to Home Screen; Android Chrome: menu → Install app).

Install only works from a secure address. The Tailscale `https://` address
works. A plain `http://10.x.x.x` address still gets the icon, but no
offline support.

## Moving around on a phone

The bottom bar has four items: **Chat**, **Create**, **Models** and **Settings**. In Chat, the list of
conversations is the first screen. Tap a conversation to open it full screen. The Back button of the phone
or the arrow in the chat header returns to the list. The composer stays above the on-screen keyboard.

## Troubleshooting

- **"Unknown host" (421):** the address you typed is not one Embernest
  accepts. Add it with `embernest config set allowedHosts <host>`.
- **"That pairing link is old":** the token was rotated. Run `embernest pair` again.
- **"Too many failed attempts" (429):** wait five minutes, then try again.
