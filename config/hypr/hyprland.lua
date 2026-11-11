-- Self-contained Hyprland config (Lua). Ported from Omarchy defaults + personal overrides.
-- Theme: Catppuccin Mocha. Helper scripts live in ~/dotfiles/bin (installed to ~/.local/bin as dot-*).
-- Replaces hyprland.conf: Hyprland loads hyprland.lua when it exists and ignores the .conf.

---------------- ENV ----------------
-- Cursor size (independent of monitor scale, which multiplies it). Keep home.pointerCursor.size in home.nix the same.
local cursorSize = 20
hl.env("XCURSOR_THEME", "Adwaita")
hl.env("XCURSOR_SIZE", tostring(cursorSize))
hl.env("HYPRCURSOR_SIZE", tostring(cursorSize))
hl.env("GDK_SCALE", "1")
hl.env("GDK_BACKEND", "wayland,x11,*")
hl.env("QT_QPA_PLATFORM", "wayland;xcb")
hl.env("QT_STYLE_OVERRIDE", "kvantum") -- dark theme set in ~/.config/Kvantum
hl.env("MOZ_ENABLE_WAYLAND", "1")
hl.env("ELECTRON_OZONE_PLATFORM_HINT", "wayland")
hl.env("OZONE_PLATFORM", "wayland")
hl.env("XDG_SESSION_TYPE", "wayland")
hl.env("XDG_CURRENT_DESKTOP", "Hyprland")
hl.env("XDG_SESSION_DESKTOP", "Hyprland")

hl.config({
	xwayland = { force_zero_scaling = true },
	ecosystem = { no_update_news = true },
})

---------------- MONITORS ----------------
-- hyprctl monitors  -> list outputs. 27" 1440p desktop display (Dell S2722DGM).
local scale = 1.5
-- DOT_VM is set only by the NixOS "vmware" specialisation; never on bare metal.
local isVM = os.getenv("DOT_VM") == "1"

-- In VMware "highrr" picks 800x600@60.32 over the 60.00 modes, so use the host-preferred mode at scale 1.
hl.monitor({ output = "", mode = isVM and "preferred" or "highrr", position = "auto", scale = isVM and 1 or scale })
-- vmwgfx: Hyprland drops clients that submit GPU (dmabuf) buffers; render clients on the CPU instead.
if isVM then hl.env("LIBGL_ALWAYS_SOFTWARE", "1") end
-- Second monitor example:
-- hl.monitor({ output = "HDMI-A-1", mode = "2560x1440@60", position = "auto", scale = 1 })

---------------- LOOK & FEEL ----------------
local activeBorderColor = "rgb(89b4fa)"
local inactiveBorderColor = "rgba(595959aa)"

-- Normal gaps/border; SUPER+SHIFT+BACKSPACE swaps these for zeros (see bindings).
-- The choice survives reloads and reboots: the flag file existing = gaps off.
local gaps = { gaps_in = 5, gaps_out = 10, border_size = 2 }
local noGaps = { gaps_in = 0, gaps_out = 0, border_size = 0 }
local noGapsFlag = (os.getenv("XDG_STATE_HOME") or (os.getenv("HOME") .. "/.local/state")) .. "/hypr-no-gaps"

local function gapsOff()
	local f = io.open(noGapsFlag)
	if f then
		f:close()
	end
	return f ~= nil
end

local startGaps = gapsOff() and noGaps or gaps

hl.config({
	general = {
		gaps_in = startGaps.gaps_in,
		gaps_out = startGaps.gaps_out,
		border_size = startGaps.border_size,
		col = {
			active_border = activeBorderColor,
			inactive_border = inactiveBorderColor,
		},
		resize_on_border = false,
		allow_tearing = false,
		layout = "dwindle",
	},

	decoration = {
		rounding = 0,

		shadow = {
			enabled = true,
			range = 2,
			render_power = 3,
			color = "rgba(1a1a1aee)",
		},

		blur = {
			enabled = true,
			size = 2,
			passes = 2,
			special = true,
			brightness = 0.60,
			contrast = 0.75,
		},
	},

	group = {
		col = {
			border_active = activeBorderColor,
			border_inactive = inactiveBorderColor,
			border_locked_active = activeBorderColor,
			border_locked_inactive = inactiveBorderColor,
		},

		groupbar = {
			font_size = 12,
			font_family = "monospace",
			font_weight_active = "ultraheavy",
			font_weight_inactive = "normal",
			indicator_height = 0,
			indicator_gap = 5,
			height = 22,
			gaps_in = 5,
			gaps_out = 0,
			text_color = "rgb(ffffff)",
			text_color_inactive = "rgba(ffffff90)",
			col = {
				active = "rgba(00000040)",
				inactive = "rgba(00000020)",
			},
			gradients = true,
			gradient_rounding = 0,
			gradient_round_only_edges = false,
		},
	},

	animations = {
		enabled = true, -- yes, please :)
	},

	dwindle = {
		preserve_split = true,
		force_split = 2,
	},

	scrolling = {
		column_width = 0.49,
	},

	master = {
		new_status = "master",
	},

	misc = {
		disable_hyprland_logo = true,
		disable_splash_rendering = true,
		disable_scale_notification = true,
		focus_on_activate = true,
		anr_missed_pings = 3,
		on_focus_under_fullscreen = 1,
		key_press_enables_dpms = true,
		mouse_move_enables_dpms = true,
	},

	cursor = {
		hide_on_key_press = true,
		warp_on_change_workspace = 1,
	},

	binds = {
		hide_special_on_workspace_change = true,
	},
})

hl.curve("easeOutQuint", { type = "bezier", points = { { 0.23, 1 }, { 0.32, 1 } } })
hl.curve("easeInOutCubic", { type = "bezier", points = { { 0.65, 0.05 }, { 0.36, 1 } } })
hl.curve("linear", { type = "bezier", points = { { 0, 0 }, { 1, 1 } } })
hl.curve("almostLinear", { type = "bezier", points = { { 0.5, 0.5 }, { 0.75, 1.0 } } })
hl.curve("quick", { type = "bezier", points = { { 0.15, 0 }, { 0.1, 1 } } })

hl.animation({ leaf = "global", enabled = true, speed = 10, bezier = "default" })
hl.animation({ leaf = "border", enabled = true, speed = 5.39, bezier = "easeOutQuint" })
hl.animation({ leaf = "windows", enabled = true, speed = 3.79, bezier = "easeOutQuint" })
hl.animation({ leaf = "windowsIn", enabled = true, speed = 4.1, bezier = "easeOutQuint", style = "popin 87%" })
hl.animation({ leaf = "windowsOut", enabled = true, speed = 1.49, bezier = "linear", style = "popin 87%" })
hl.animation({ leaf = "fadeIn", enabled = true, speed = 1.73, bezier = "almostLinear" })
hl.animation({ leaf = "fadeOut", enabled = true, speed = 1.46, bezier = "almostLinear" })
hl.animation({ leaf = "fade", enabled = true, speed = 3.03, bezier = "quick" })
hl.animation({ leaf = "layers", enabled = true, speed = 3.81, bezier = "easeOutQuint" })
hl.animation({ leaf = "layersIn", enabled = true, speed = 4, bezier = "easeOutQuint", style = "fade" })
hl.animation({ leaf = "layersOut", enabled = true, speed = 1.5, bezier = "linear", style = "fade" })
hl.animation({ leaf = "fadeLayersIn", enabled = true, speed = 1.79, bezier = "almostLinear" })
hl.animation({ leaf = "fadeLayersOut", enabled = true, speed = 1.39, bezier = "almostLinear" })
hl.animation({ leaf = "workspaces", enabled = false, speed = 1, bezier = "default" })
hl.animation({ leaf = "specialWorkspace", enabled = true, speed = 3, bezier = "easeOutQuint", style = "slidevert" })

---------------- INPUT ----------------
hl.config({
	input = {
		kb_layout = "us",
		kb_options = "compose:caps",
		repeat_rate = 40,
		repeat_delay = 250,
		numlock_by_default = true,
		follow_mouse = 1,
		sensitivity = 0,
		force_no_accel = true,

		touchpad = {
			natural_scroll = false,
			scroll_factor = 0.4,
		},
	},
})

---------------- WINDOW RULES ----------------
local rule = hl.window_rule

rule({ match = { class = ".*" }, suppress_event = "maximize" })
rule({ match = { class = ".*" }, tag = "+default-opacity" })
rule({
	match = { class = "^$", title = "^$", xwayland = true, float = true, fullscreen = false, pin = false },
	no_focus = true,
})

-- Browsers
rule({
	match = { class = "((google-)?[cC]hrom(e|ium)|[bB]rave-browser|[mM]icrosoft-edge|Vivaldi-stable|helium)" },
	tag = "+chromium-based-browser",
})
rule({ match = { class = "([fF]irefox|zen|librewolf)" }, tag = "+firefox-based-browser" })
rule({ match = { tag = "chromium-based-browser" }, tag = "-default-opacity" })
rule({ match = { tag = "firefox-based-browser" }, tag = "-default-opacity" })
rule({
	match = { class = "(chrome-youtube.com__-Default|chrome-app.zoom.us__wc_home-Default)" },
	tag = "-chromium-based-browser",
})
rule({
	match = { class = "(chrome-youtube.com__-Default|chrome-app.zoom.us__wc_home-Default)" },
	tag = "-default-opacity",
})
rule({ match = { tag = "chromium-based-browser" }, tile = true })
rule({ match = { tag = "chromium-based-browser" }, opacity = "1.0 0.985" })
rule({ match = { tag = "firefox-based-browser" }, opacity = "1.0 0.985" })
rule({ match = { title = ".*is sharing.*" }, workspace = "special silent" })

-- Terminals
rule({ match = { class = "(Alacritty|kitty|com.mitchellh.ghostty|foot)" }, tag = "+terminal" })
rule({ match = { tag = "terminal" }, tag = "-default-opacity" })
rule({ match = { tag = "terminal" }, opacity = "0.985 0.96" })
rule({ match = { class = "(Alacritty|kitty|foot)" }, scroll_touchpad = 1.5 })
rule({ match = { class = "com.mitchellh.ghostty" }, scroll_touchpad = 0.2 })

-- Picture-in-picture
rule({ match = { title = "(Picture.?in.?[Pp]icture)" }, tag = "+pip" })
rule({ match = { tag = "pip" }, tag = "-default-opacity" })
rule({
	match = { tag = "pip" },
	float = true,
	pin = true,
	size = { 600, 338 },
	keep_aspect_ratio = true,
	border_size = 0,
	opacity = "1 1",
	move = "(monitor_w-window_w-40) (monitor_h*0.04)",
})

-- Steam
rule({ match = { class = "steam" }, float = true })
rule({ match = { class = "steam", title = "Steam" }, center = true })
rule({ match = { class = "steam.*" }, tag = "-default-opacity" })
rule({ match = { class = "steam.*" }, opacity = "1 1" })
rule({ match = { class = "steam", title = "Steam" }, size = { 1100, 700 } })
rule({ match = { class = "steam", title = "Friends List" }, size = { 460, 800 } })
rule({ match = { class = "steam" }, idle_inhibit = "fullscreen" })

-- Floating helpers (TUI launched via dot-launch-tui get class org.local.<cmd>)
rule({ match = { tag = "floating-window" }, float = true, center = true, size = { 875, 600 } })
rule({
	match = {
		class = "(org.local.bluetui|org.local.nmtui|org.local.wiremix|org.local.btop|org.gnome.NautilusPreviewer|org.gnome.Evince|com.gabm.satty|imv|mpv)",
	},
	tag = "+floating-window",
})
rule({
	match = {
		class = "(xdg-desktop-portal-gtk|org.gnome.Nautilus)",
		title = "^(Open.*Files?|Open [F|f]older.*|Save.*Files?|Save.*As|Save|All Files|.*wants to [open|save].*|[C|c]hoose.*)",
	},
	tag = "+floating-window",
})
rule({ match = { class = "org.gnome.Calculator" }, float = true })

-- No transparency on media windows
local mediaClasses =
	"^(zoom|vlc|mpv|org.kde.kdenlive|com.obsproject.Studio|com.github.PintaProject.Pinta|imv|org.gnome.NautilusPreviewer)$"
rule({ match = { class = mediaClasses }, tag = "-default-opacity" })
rule({ match = { class = mediaClasses }, opacity = "1 1" })
rule({ match = { class = "qemu" }, tag = "-default-opacity" })
rule({ match = { class = "qemu" }, opacity = "1 1" })

rule({ match = { tag = "pop" }, rounding = 8 })
rule({ match = { tag = "noidle" }, idle_inhibit = "always" })

hl.layer_rule({ match = { namespace = "launcher" }, no_anim = true })
-- slurp's dim overlay and hyprpicker's freeze must vanish instantly, or grim captures them fading out
hl.layer_rule({ match = { namespace = "^(selection|hyprpicker)$" }, no_anim = true })

-- LocalSend, 1Password, Typora, Telegram
rule({ match = { class = "(Share|localsend)" }, float = true, center = true })
rule({ match = { class = "localsend" }, size = { 1100, 700 } })
rule({ match = { class = "^(1[p|P]assword)$" }, no_screen_share = true })
rule({ match = { class = "^(1[p|P]assword)$" }, tag = "+floating-window" })
rule({ match = { class = "^Typora$", title = "^Print$" }, float = true, center = true })
rule({ match = { class = "org.telegram.desktop" }, focus_on_activate = false })

-- Default opacity last, after apps had a chance to opt out
rule({ match = { tag = "default-opacity" }, opacity = "0.985 0.96" })

---------------- AUTOSTART ----------------
hl.on("hyprland.start", function()
	-- Boot autologin (greetd initial_session) lands here unauthenticated: lock first thing
	if os.getenv("DOT_AUTOLOGIN") == "1" then
		hl.exec_cmd("hyprlock")
	end
	-- Launched straight from greetd (no uwsm), so mark the systemd graphical session active
	-- once the env is imported. Without it xdg-desktop-portal (dark mode, file pickers,
	-- screen share) and hyprpolkitagent refuse to start.
	hl.exec_cmd(
		"systemctl --user import-environment WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE HYPRLAND_INSTANCE_SIGNATURE"
			.. " && systemctl --user start nixos-fake-graphical-session.target"
			-- waybar via its packaged unit (needs the session target), so Restart=on-failure
			-- brings it back if it crashes, e.g. while a rebuild swaps its config symlink
			.. " && systemctl --user start waybar"
	)
	hl.exec_cmd("mako")
	hl.exec_cmd("swaybg -i ~/.config/hypr/wallpaper.png -m fill")
	hl.exec_cmd("swayosd-server")
	hl.exec_cmd("wl-paste --type text --watch cliphist store")
	hl.exec_cmd("wl-paste --type image --watch cliphist store")
	hl.exec_cmd("systemctl --user start hyprpolkitagent")
	hl.exec_cmd("systemctl --user import-environment $(env | cut -d'=' -f 1)")
	hl.exec_cmd("dbus-update-activation-environment --systemd --all")
end)

---------------- BINDINGS ----------------
local dsp = hl.dsp
local exec = dsp.exec_cmd

-- bind(keys, description, dispatcher, extra flags)
local function bind(keys, desc, action, opts)
	opts = opts or {}
	opts.description = desc
	hl.bind(keys, action, opts)
end

local media = { repeating = true, locked = true } -- bindel
local locked = { locked = true } -- bindl

-- --- Clipboard
bind("SUPER + C", "Universal copy", dsp.send_shortcut({ mods = "CTRL", key = "Insert" }))
bind("SUPER + V", "Universal paste", dsp.send_shortcut({ mods = "SHIFT", key = "Insert" }))
bind("SUPER + X", "Universal cut", dsp.send_shortcut({ mods = "CTRL", key = "X" }))
bind("SUPER + CTRL + V", "Clipboard manager", exec("dot-clipboard"))

-- --- Media (swayosd)
bind("XF86AudioRaiseVolume", "Volume up", exec("swayosd-client --output-volume raise"), media)
bind("XF86AudioLowerVolume", "Volume down", exec("swayosd-client --output-volume lower"), media)
bind("XF86AudioMute", "Mute", exec("swayosd-client --output-volume mute-toggle"), media)
bind("XF86AudioMicMute", "Mute microphone", exec("swayosd-client --input-volume mute-toggle"), media)
bind("ALT + XF86AudioRaiseVolume", "Volume up precise", exec("swayosd-client --output-volume +1"), media)
bind("ALT + XF86AudioLowerVolume", "Volume down precise", exec("swayosd-client --output-volume -1"), media)
bind("XF86AudioNext", "Next track", exec("swayosd-client --playerctl next"), locked)
bind("XF86AudioPause", "Pause", exec("swayosd-client --playerctl play-pause"), locked)
bind("XF86AudioPlay", "Play", exec("swayosd-client --playerctl play-pause"), locked)
bind("XF86AudioPrev", "Previous track", exec("swayosd-client --playerctl previous"), locked)
bind("SUPER + XF86AudioMute", "Switch audio output", exec("dot-audio-output-switch"), locked)
bind("XF86Calculator", "Calculator", exec("gnome-calculator"))

-- --- Tiling
-- Close windows
bind("SUPER + W", "Close window", dsp.window.close())
bind("CTRL + ALT + DELETE", "Close all windows", exec("dot-window-close-all"))

-- Move focus with SUPER + arrow keys
bind("SUPER + LEFT", "Focus on left window", dsp.focus({ direction = "left" }))
bind("SUPER + RIGHT", "Focus on right window", dsp.focus({ direction = "right" }))
bind("SUPER + UP", "Focus on above window", dsp.focus({ direction = "up" }))
bind("SUPER + DOWN", "Focus on below window", dsp.focus({ direction = "down" }))

-- Workspaces with SUPER + [1-9; 0] (keycodes 10-19, layout independent)
for i = 1, 10 do
	local key = "code:" .. (i + 9)
	bind("SUPER + " .. key, "Switch to workspace " .. i, dsp.focus({ workspace = i }))
	bind("SUPER + SHIFT + " .. key, "Move window to workspace " .. i, dsp.window.move({ workspace = i }))
	bind(
		"SUPER + SHIFT + ALT + " .. key,
		"Move window silently to workspace " .. i,
		dsp.window.move({ workspace = i, follow = false })
	)
end

-- Control scratchpad
bind("SUPER + S", "Toggle scratchpad", dsp.workspace.toggle_special("scratchpad"))
bind(
	"SUPER + ALT + S",
	"Move window to scratchpad",
	dsp.window.move({ workspace = "special:scratchpad", follow = false })
)

-- TAB between workspaces
bind("SUPER + TAB", "Next workspace", dsp.focus({ workspace = "e+1" }))
bind("SUPER + SHIFT + TAB", "Previous workspace", dsp.focus({ workspace = "e-1" }))
bind("SUPER + CTRL + TAB", "Former workspace", dsp.focus({ workspace = "previous" }))

-- Move workspaces to other monitors
bind("SUPER + SHIFT + ALT + LEFT", "Move workspace to left monitor", dsp.workspace.move({ monitor = "l" }))
bind("SUPER + SHIFT + ALT + RIGHT", "Move workspace to right monitor", dsp.workspace.move({ monitor = "r" }))
bind("SUPER + SHIFT + ALT + UP", "Move workspace to up monitor", dsp.workspace.move({ monitor = "u" }))
bind("SUPER + SHIFT + ALT + DOWN", "Move workspace to down monitor", dsp.workspace.move({ monitor = "d" }))

-- Swap active window with the one next to it with SUPER + SHIFT + arrow keys
bind("SUPER + SHIFT + LEFT", "Swap window to the left", dsp.window.swap({ direction = "left" }))
bind("SUPER + SHIFT + RIGHT", "Swap window to the right", dsp.window.swap({ direction = "right" }))
bind("SUPER + SHIFT + UP", "Swap window up", dsp.window.swap({ direction = "up" }))
bind("SUPER + SHIFT + DOWN", "Swap window down", dsp.window.swap({ direction = "down" }))

-- Cycle through applications on active workspace (and reveal it on top)
bind("ALT + TAB", "Focus on next window", function()
	hl.dispatch(dsp.window.cycle_next())
	hl.dispatch(dsp.window.bring_to_top())
end)
bind("ALT + SHIFT + TAB", "Focus on previous window", function()
	hl.dispatch(dsp.window.cycle_next({ next = false }))
	hl.dispatch(dsp.window.bring_to_top())
end)

-- Cycle through monitors
bind("CTRL + ALT + TAB", "Focus on next monitor", dsp.focus({ monitor = "+1" }))
bind("CTRL + ALT + SHIFT + TAB", "Focus on previous monitor", dsp.focus({ monitor = "-1" }))

-- Resize active window (code:20 = minus, code:21 = equal)
bind("SUPER + code:20", "Expand window left", dsp.window.resize({ x = -100, y = 0, relative = true }))
bind("SUPER + code:21", "Shrink window left", dsp.window.resize({ x = 100, y = 0, relative = true }))
bind("SUPER + SHIFT + code:20", "Shrink window up", dsp.window.resize({ x = 0, y = -100, relative = true }))
bind("SUPER + SHIFT + code:21", "Expand window down", dsp.window.resize({ x = 0, y = 100, relative = true }))

-- Scroll through existing workspaces with SUPER + scroll
bind("SUPER + mouse_down", "Scroll active workspace forward", dsp.focus({ workspace = "e+1" }))
bind("SUPER + mouse_up", "Scroll active workspace backward", dsp.focus({ workspace = "e-1" }))

-- Move/resize windows with SUPER + LMB/RMB and dragging
bind("SUPER + mouse:272", "Move window", dsp.window.drag(), { mouse = true })
bind("SUPER + mouse:273", "Resize window", dsp.window.resize(), { mouse = true })

-- Toggle groups
bind("SUPER + G", "Toggle window grouping", dsp.group.toggle())
bind("SUPER + ALT + G", "Move active window out of group", dsp.window.move({ out_of_group = true }))

-- Join groups
bind("SUPER + ALT + LEFT", "Move window to group on left", dsp.window.move({ into_group = "left" }))
bind("SUPER + ALT + RIGHT", "Move window to group on right", dsp.window.move({ into_group = "right" }))
bind("SUPER + ALT + UP", "Move window to group on top", dsp.window.move({ into_group = "up" }))
bind("SUPER + ALT + DOWN", "Move window to group on bottom", dsp.window.move({ into_group = "down" }))

-- Navigate a single set of grouped windows
bind("SUPER + ALT + TAB", "Next window in group", dsp.group.next())
bind("SUPER + ALT + SHIFT + TAB", "Previous window in group", dsp.group.prev())

-- Window navigation for grouped windows
bind("SUPER + CTRL + LEFT", "Move grouped window focus left", dsp.group.prev())
bind("SUPER + CTRL + RIGHT", "Move grouped window focus right", dsp.group.next())

-- Scroll through a set of grouped windows with SUPER + ALT + scroll
bind("SUPER + ALT + mouse_down", "Next window in group", dsp.group.next())
bind("SUPER + ALT + mouse_up", "Previous window in group", dsp.group.prev())

-- Activate window in a group by number
for i = 1, 5 do
	bind("SUPER + ALT + code:" .. (i + 9), "Switch to group window " .. i, dsp.group.active({ index = i }))
end

-- Window state (tiling-v2 extras)
bind("SUPER + J", "Toggle window split", dsp.layout("togglesplit"))
bind("SUPER + P", "Pseudo window", dsp.window.pseudo())
bind("SUPER + T", "Toggle window floating/tiling", dsp.window.float({ action = "toggle" }))
bind("SUPER + F", "Full screen", dsp.window.fullscreen({ mode = "fullscreen" }))
bind("SUPER + CTRL + F", "Tiled full screen", dsp.window.fullscreen_state({ internal = 0, client = 2 }))
bind("SUPER + ALT + F", "Full width", dsp.window.fullscreen({ mode = "maximized" }))
bind("SUPER + SHIFT + BACKSPACE", "Toggle gaps and borders", function()
	local off = not gapsOff()
	if off then
		io.open(noGapsFlag, "w"):close()
	else
		os.remove(noGapsFlag)
	end
	hl.config({ general = off and noGaps or gaps })
end)

-- --- Launchers / utilities
bind("SUPER + SPACE", "Launch apps", exec("fuzzel"))
bind("SUPER + O", "Power menu", exec("dot-power"))
bind("SUPER + ESCAPE", "Lock system", exec("dot-lock"))
bind("XF86PowerOff", "Lock", exec("dot-lock"), locked)
bind("SUPER + CTRL + L", "Lock system", exec("dot-lock"))
bind("SUPER + CTRL + SPACE", "Tmux sessions", exec("dot-tmux-sessions"))
bind("SUPER + ALT + M", "Adopt terminal into tmux", exec("dot-agent-persist adopt"))
bind("SUPER + SHIFT + SPACE", "Toggle top bar", exec("pkill -SIGUSR1 waybar"))

-- Notifications
bind("SUPER + N", "Notification center", exec("dot-launch-tui dot-notifications"))
bind("SUPER + COMMA", "Dismiss last notification", exec("makoctl dismiss"))
bind("SUPER + SHIFT + COMMA", "Dismiss all notifications", exec("makoctl dismiss --all"))
bind("SUPER + CTRL + COMMA", "Toggle silencing notifications", exec("dot-toggle-notification-silencing"))
bind("SUPER + ALT + COMMA", "Invoke last notification", exec("makoctl invoke"))
bind("SUPER + SHIFT + ALT + COMMA", "Restore last notification", exec("makoctl restore"))

-- Toggles
bind("SUPER + CTRL + N", "Toggle nightlight", exec("dot-toggle-nightlight"))

-- Captures
bind("SUPER + R", "Start/stop screen recording", exec("dot-record"))
bind("PRINT", "Screenshot", exec("dot-screenshot"))
bind("SUPER + CTRL + C", "Screenshot", exec("dot-screenshot"))
bind("SUPER + PRINT", "Color picker", exec("pkill hyprpicker || hyprpicker -a"))

-- Control panels
bind("SUPER + CTRL + A", "Audio controls", exec("dot-launch-tui wiremix"))
bind("SUPER + CTRL + B", "Bluetooth controls", exec("dot-launch-tui bluetui"))
bind("SUPER + CTRL + W", "Wifi controls", exec("dot-launch-tui nmtui"))
bind("SUPER + CTRL + T", "Activity", exec('dot-launch-or-focus btop "dot-launch-tui btop"'))

-- Zoom (magnifier around the cursor)
bind("SUPER + CTRL + Z", "Zoom in", function()
	hl.config({ cursor = { zoom_factor = hl.get_config("cursor.zoom_factor") + 1 } })
end)
bind("SUPER + CTRL + ALT + Z", "Reset zoom", function()
	hl.config({ cursor = { zoom_factor = 1 } })
end)

-- --- Applications (personal)
bind("SUPER + RETURN", "Terminal", exec('ghostty --working-directory="$(dot-terminal-cwd)"'))
bind(
	"SUPER + ALT + RETURN",
	"Tmux",
	exec('ghostty --working-directory="$(dot-terminal-cwd)" -e bash -c "tmux attach || tmux new -s Work"')
)
bind("SUPER + SHIFT + RETURN", "Browser", exec("dot-launch-browser"))
bind("SUPER + SHIFT + F", "File manager", exec("nautilus --new-window"))
bind("SUPER + ALT + SHIFT + F", "File manager (cwd)", exec('nautilus --new-window "$(dot-terminal-cwd)"'))
bind("SUPER + SHIFT + B", "Browser", exec("dot-launch-browser"))
bind("SUPER + SHIFT + ALT + B", "Browser (private)", exec("dot-launch-browser --private"))
bind("SUPER + SHIFT + M", "Music", exec("dot-launch-or-focus spotify"))
bind("SUPER + SHIFT + N", "Editor", exec("dot-launch-editor"))
bind("SUPER + SHIFT + D", "Docker", exec("dot-launch-tui lazydocker"))
bind("SUPER + SHIFT + SLASH", "Passwords", exec("keepassxc"))
bind("SUPER + K", "Show keybindings", exec("dot-keybinds"))
bind("SUPER + SHIFT + Y", "YouTube", exec('dot-launch-webapp "https://youtube.com/"'))
bind(
	"SUPER + SHIFT + ALT + G",
	"WhatsApp",
	exec('dot-launch-or-focus WhatsApp "dot-launch-webapp https://web.whatsapp.com/"')
)

-- Screen off (after 2s so the key release doesn't wake it)
bind("SUPER + ALT + SPACE", "Screen off", function()
	hl.timer(function()
		hl.dispatch(dsp.dpms({ action = "disable" }))
	end, { timeout = 2000, type = "oneshot" })
end)

-- Passthrough: SUPER + ALT + ESCAPE disables all binds below so keys reach the
-- focused window (e.g. RustDesk); press it again to restore.
bind("SUPER + ALT + ESCAPE", "Passthrough mode (binds go to app)", dsp.submap("passthrough"))
hl.define_submap("passthrough", function()
	bind("SUPER + ALT + ESCAPE", "Exit passthrough mode", dsp.submap("reset"))
end)
