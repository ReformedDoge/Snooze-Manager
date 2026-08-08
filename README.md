### Snooze-Manager

Snooze-Manager is a modular plugin manager for Pengu Loader. Each QoL feature is implemented as a separate module, and the manager loads them together while keeping configuration consolidated.

Everything is built to be lightweight and event driven: no embedded React application, no bloat, no constant polling of the client for changes and so on.

The plugin UI is fully translated and switches language from Settings: English (default), Spanish, French, Korean, Chinese, Portuguese (Brazil) and Turkish.

*Some features are inspired by earlier work, but the implementation here is independent and expanded to offer more than a straight copy.*
<img width="3817" height="2665" alt="image" src="https://github.com/user-attachments/assets/e7356315-b4fb-4aff-add2-ee051163787d" />

### Modules

- `ARAM No Cooldown`: Swapping champions, name says it all.
- `Arena God`: Challenge progress display & status icons for champions you have played or won first place with.
- `Auto Accept`: Auto-accept with optional delay, queue exit on other's decline or champ-select dodge & optional toggle to hide of the queue pop.
- `Auto Honor`: Auto-honor a teammate, enemy, random player, or skip. Prefer Friends option honors friends first, Optional Friends Badge and Stats UI over the honor cards.
- `Auto Queue`: Automatically re-queues your chosen game mode after a match ends, with configurable delay (5 seconds by default).
- `Auto Select`: Automatically hovers, locks, or bans champions by priority & role in champion select, with separate top-3 prio lists per role. Hover-then-lock delay, "Respect Team Intent" (never auto-ban what a teammate wants) & "Allow Manual Pick" are supported, plus a searchable champ picker.
- `Mode Balance Info`: Hover over champions (ARAM/Swiftplay/URF/Arena/...) to see balance adjustments & raw stat changes.
- `Champ Select Dodge`: Adds a dodge button inside the champion select action bar.
- `Client Window Tweaks`: Apply custom client resolution, window title & drag bar.
- `Custom Online Status`: Change your online status & status message. Configurable via the menu or when clicking the online indicator below your icon.
- `Penalty UI Suppression`: Suppresses low priority queue, leaverbuster & queue failure warning dialogs, plus the chat/ranked restriction info tooltip. Old setting is migrated after the rename.
- `Mode Selector Tweaks`: Declutter the mode selector page by hiding unwanted game mode tabs, cards & queue entries.
- `Player Analysis`: Auto-opens a modal displaying rank & recent stats for all players when a game starts. Optionally shows players stats in champion select & highlights premades in both views.
- `Profile Tweaks`: Remove profile banner/border, clone challenge token & unlock profile background.
- `Social Panel Tweaks`: Enhances the social panel with queue labels, in-game timers, highlighting for same-lobby friends, a collapsible sidebar (crop/stretch/slide) & a group folder invite option.
- `Use Client In Game`: Dismiss the "game in progress" screen so you can browse the client (profile, collection, match history) during a live game. The PLAY button is disabled while the game runs so you can't queue a new one, and the screen returns automatically when a reconnect is needed.
- `Whales Helper`: Shows rerollable skins, icons, wards & emotes you don't own via a button on the loot page. Adds skin-tier badges above names in champion select (incl. full CN/Tencent rarity support), filters unowned skins in champion select, and adds a loot drop-table odds previewer with per-item pool viewer (via the loot tab context menu).
- `Name Spoofer`: Locally spoofs displayed names for you and other players. Cosmetic only.

### Modes: Manager vs Standalone

- Manager mode: install the whole `Snooze-Manager` plugin. Use the manager hotkey to open the unified settings UI and manage all modules in one place.
- Standalone mode: if you only want one module without the manager, copy `generalUtils.js` plus the desired module file from `modules` into `\Pengu Loader\plugins`. In that case, the module will use the League of Legends native settings menu instead of the manager hotkey interface.

### Credits
- Name Spoofer By [Lx](https://github.com/iIlusion)
- Original balance buff viewer concept by Nomi.
- Better Friends Status, champion select player analysis, custom online status initial concept from wjz_p's Sona.


<!-- CONTRIBUTORS:START -->

### Contributors

<img src="https://gist.githubusercontent.com/ReformedDoge/bd2de93ddd28d00206dcc094e83c7aca/raw/aeaae7314e77bdf9449d1dd866d8243a4edf2e0f/contributors.svg" alt="Contributor statistics" width="584" />

<!-- CONTRIBUTORS:END -->