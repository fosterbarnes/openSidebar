# openSidebar
Sidebar customization plugin for OpenCode.

*NOT COMPLETE* - tested only on Windows 10 LTSC IoT. Linux/Mac planned but not guaranteed to work. PRs/forks welcome.

## Features

### Header buttons

**`> Switch Session`**

invokes the 'switch session' command

**`> model`**

brings up the 'select model' menu

**`> weight`**

toggle through weight options

**`Weekly usage`**

see your weekly usage and when it resets. not all platforms are currently supported

**`Scripts`**

Run/reference project scripts with `pwsh`. Left-click to run, right-click to paste.

**`Files`**

Browse/copy files in-terminal. Click to change dir.

## Install
1. Open `%USERPROFILE%\.config\opencode\tui.json`
2. Add:
```json
{ "plugin": ["open-sidebar"] }
```
3. Restart OpenCode.

## Screenshot

<img src=".res/scr/1.png" width="300">