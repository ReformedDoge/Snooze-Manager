### Snooze-Manager

Snooze-Manager is a modular plugin manager for Pengu Loader. Each QoL feature is implemented as a separate module, and the manager loads them together while keeping configuration consolidated.

Everything is built to be lightweight and event driven: no embedded React application, no bloat, no constant polling of the client for changes and so on.

*Some features are inspired by earlier work, but the implementation here is independent and expanded to offer more than a straight copy.*
<img width="3817" height="2665" alt="image" src="https://github.com/user-attachments/assets/e7356315-b4fb-4aff-add2-ee051163787d" />

### Modules

- `ARAM No Cooldown`: Swapping champions, name says it all.
- `Arena God Tracker`: Challange progress display & status icons for champions you have played or won first place with.
- `Auto Accept`: Auto-accept with optional delay & queue exit on decline.
- `Auto Honor`: Auto-honor a teammate, enemy, r&om player, or skip when the game finishes.
- `Auto Queue`: Automatically re-queues your chosen game mode after a match ends, with configurable delay.
- `Auto Select Champion`: Automatically hovers, locks, or bans champions by priority & role in champion select, with separate top-3 prio lists per role.
- `Balance Tooltip`: Hover over champions (ARAM/URF/Arena) to see balance adjustments.
- `Champ Select Dodge`: Adds a dodge button inside the champion select action bar.
- `Client Window Tweaks`: Apply custom client resolution, window title & drag bar.
- `Custom Online Status`: Change your online status & status message. configurable via the menu or when clicking the online indicator below your icon.
- `Low Priority Warning Suppress`: Suppresses low priority queue, leaverbuster & queue failer warning dialogs.
- `Mode Selector Tweaks`: Declutter the mode selector page by hiding unwanted game mode tabs, cards & queue entries.
- `Player Analysis`: Auto-opens a modal displaying rank & recent stats for all players when a game starts. Optionally shows players stats in champion select & highlights premades in both views.
- `Profile Tweaks`: Remove profile banner/border, clone challenge token & unlock profile background.
- `Social Panel Tweaks`: Enhances the social panel with queue labels, in-game timers, highlighting for same lobby friends, a collapsible sidebar (crop/stretch/slide) & a group folder invite option.
- `Whale Helper`: Shows rerollable skins, icons, wards & emotes you don't own via a button on the loot page. Adds skin tier badges above name in champion select. Filters out unowned skins/chromas in champion select for a less cluttered skin carousel & chroma picker. Adds a loot drop table odds previewer accessible via the loot tab context menu (right click).

### Modes: Manager vs Standalone

- Manager mode: install the whole `Snooze-Manager` plugin. Use the manager hotkey to open the unified settings UI and manage all modules in one place.
- Standalone mode: if you only want one module without the manager, copy `generalUtils.js` plus the desired module file from `modules` into `\Pengu Loader\plugins`. In that case, the module will use the League of Legends native settings menu instead of the manager hotkey interface.

### Credits

Original balance buff viewer concept by Nomi.
The idea of packaging a collection of plugins came from wjz_p's Sona.
Better Friends Status, champion select player analysis, custom online status initial concept from sona.
