# Asa Gloria’s Lounge

No-limit Texas Hold'em for you and your friends. There are no accounts. Each player picks a name, the host starts a table, and everyone else joins with the 5-letter code or the invite link.

## Put it online for free (Render, about 10 minutes)

1. **Create a GitHub repository.** Sign in at github.com, click **New repository**, name it `poker-night`, and create it. On the empty repo page, click **uploading an existing file**, then drag in everything from this folder (`server.js`, `package.json`, `render.yaml`, `README.md` and the `public` and `test` folders). Click **Commit changes**.
2. **Create the site on Render.** Sign up at render.com (you can use your GitHub account). Click **New → Web Service**, connect GitHub, and pick the `poker-night` repo. Render reads the settings from `render.yaml`. If it asks anyway, use:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
3. Click **Create Web Service**. After a minute or two you get an address like `https://poker-night-xxxx.onrender.com`. Send it to your friends.

### Good to know on the free plan
- **No time limit while you play.** Games can run as long as you like. While anyone has the site open, it sends a tiny keep-alive message every few minutes so the server stays awake.
- **It sleeps when everyone has left.** About 15 minutes after the last person closes the site, the free service goes to sleep. The next visitor waits about a minute while it wakes up, so open the site a minute before game time.
- **Tables are cleared when it sleeps.** Open tables and chip counts don't carry over to the next session.
- **Monthly hours:** the free plan includes 750 hours a month, which is more than a full month of running.

## Running it on your own computer

You need Node.js 18 or newer from nodejs.org.

```
npm install
npm start
```

Then open http://localhost:3000. Friends on the same Wi-Fi can join using your computer's local IP address, for example `http://192.168.1.20:3000`.

## Changing the dealer picture

The dealer is the image `public/dealer.webp`. To use a different photo, replace that file with another image of the same name (a picture with a see-through background looks best), then upload it to your GitHub repo. Render updates the site by itself.

## Game modes

- **Casual:** play as long as you like. Each player can buy in up to 2 times per table (sitting down counts as the first). A player who leaves and comes back keeps the chips they left with.
- **Tournament:** everyone starts with the same chips. The blinds double every 3, 5, 8 or 10 minutes (the host picks). Pausing the game also pauses the blind clock. A player who runs out of chips is out and watches the rest. The last player with chips wins.

Starting chips and blinds, the same choices in both modes: 20,000 (100/200), 100,000 (500/1,000), 600,000 (3,000/6,000) or 1,000,000 (5,000/10,000).

## How the game works

- **Fair deals:** the server shuffles a full 52-card deck with a Fisher–Yates shuffle, using your operating system's cryptographic randomness. That makes every possible order of the deck equally likely, like a perfectly shuffled real deck. Cards are dealt one at a time around the table from the dealer's left, and a card is burned before the flop, turn and river. Run `npm test` to deal 200,000 hands and compare the results with the real odds.
- **Nobody can peek:** the server deals and sends each player only their own two cards. Other players' cards are only sent at showdown, and the host can't see them either.
- **Hand helper:** your best hand is shown in plain words as the board comes out, for example "Pocket Kings", "Pair of Nines", "Kings and Queens" or "Set of Sixes". It also flags draws (flush draw, open-ended or gutshot straight draw), and the cards on the board that make your hand are outlined. The **Hands** tab lists the hand rankings from best to worst, with yours highlighted.
- **House rules:** no-limit betting with standard minimum raises, side pots, split pots, and heads-up blind rules. You can set a turn timer, and anyone who times out twice is sat out. Players can buy back in when they run out of chips.
- **Players who leave:** if someone closes their tab, the game folds for them after 25 seconds and sits them out. Refreshing the page keeps your seat, because your browser remembers you. If the host is gone for a minute, the host controls pass to another player.
