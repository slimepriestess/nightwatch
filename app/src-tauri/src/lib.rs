// Nightwatch, phase B step 1: a native shell around the phase-1 viewer.
//
// The page is still served by gui/server.mjs (one renderer, so the browser
// viewer and the app can't drift). This shell adds what a browser tab can't:
// a frameless transparent window, a menu-bar icon, and starting the server
// when it isn't running. Step 2 renders in the webview from gui/emitter.mjs
// once Fable's port lands; write actions arrive through window.NW_HOST.
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// NIGHTWATCH_PORT overrides (a rehearsal build beside the installed app); 7352 otherwise.
fn port() -> u16 { std::env::var("NIGHTWATCH_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7352) }

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

// An app launched from Finder gets launchd's bare PATH, so a plain `node`
// fails to spawn (the orphan fold could never start for exactly this reason,
// 10/3–10/5). Look in the usual places, then ask a login shell.
fn find_node() -> Option<PathBuf> {
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if Path::new(p).is_file() {
            return Some(PathBuf::from(p));
        }
    }
    // A login shell's PATH: zsh on macOS; on Linux the person's own $SHELL,
    // then bash (most Linux installs have no zsh, nightwatch#2). The shell is
    // only ever the program run, never text spliced into a command line, and
    // the command it runs is fixed.
    let mut shells: Vec<String> = vec!["/bin/zsh".into()];
    if !cfg!(target_os = "macos") {
        shells = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).into_iter().collect();
        shells.push("/bin/bash".into());
    }
    for sh in shells {
        let Ok(out) = Command::new(&sh).args(["-lc", "command -v node"]).output() else { continue };
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() && Path::new(&s).is_file() { return Some(PathBuf::from(s)); }
    }
    // nvm installs node per version under ~/.nvm and wires it up only in an
    // interactive shell's rc file, which a login shell may not read (WSL's
    // first install, 10/16). The newest version installed.
    let nvm = home().join(".nvm/versions/node");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&nvm).ok()?.flatten().map(|e| e.path().join("bin/node")).filter(|p| p.is_file()).collect();
    versions.sort_by_key(|p| node_version(p));
    versions.pop()
}

// "v22.21.1" from ~/.nvm/versions/node/v22.21.1/bin/node, as numbers, so
// v22 sorts above v9.
fn node_version(p: &Path) -> Vec<u64> {
    p.ancestors().nth(2).and_then(|d| d.file_name()).map(|n| n.to_string_lossy().trim_start_matches('v').split('.').map(|x| x.parse().unwrap_or(0)).collect()).unwrap_or_default()
}

fn server_up() -> bool { server_up_at(port()) }
fn server_up_at(port: u16) -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).is_ok()
}

// Start gui/server.mjs if nothing answers on the port. It outlives the app on
// purpose: the browser viewer at 7352 keeps working after the app quits. So
// whatever answers may be running other code than this tree's: this tree
// before a pull, a tree since removed (WSL, 10/21: a viewer from a deleted
// worktree answered every page with ENOENT), or another hub's living viewer.
// The first two are replaced, loudly; the last, and anything that isn't a
// Nightwatch viewer at all, is never killed: the app says what holds the port.
fn ensure_server() -> Result<(), String> { ensure_server_at(port(), &repo()) }
fn ensure_server_at(port: u16, repo: &Path) -> Result<(), String> {
    let mut replaced: Option<String> = None;
    if server_up_at(port) {
        let a = answerer_on(port);
        let alive = match &a { Answerer::Viewer { root: Some(r), .. } => is_repo(r), _ => false };
        match judge(&a, repo, newest_code(repo), alive, port) {
            Verdict::Keep => return Ok(()),
            Verdict::Refuse(why) => return Err(why),
            Verdict::Replace(pid, why) => {
                log::warn!("replacing the viewer server on port {port}: {}; {why}", a.describe());
                if !stop_server(pid, port) {
                    return Err(format!("the old viewer server ({}) wouldn't stop, so port {port} is still taken; it was being replaced because {why}", a.describe()));
                }
                log::info!("stopped the old viewer server (pid {pid})");
                replaced = Some(format!("Nightwatch replaced a stale viewer server ({why}), but "));
            }
        }
    }
    let said = |e: String| match &replaced { Some(r) => format!("{r}{e}"), None => e };
    let node = find_node().ok_or_else(|| said("node not found (looked in /opt/homebrew/bin, /usr/local/bin, the login shell and ~/.nvm)".into()))?;
    // A downloaded build on a machine with no hub yet has no tree to find:
    // say how to give it one instead of failing on a file it can't open.
    if !is_repo(repo) {
        return Err(said("Nightwatch can't find its source checkout (the viewer and machinery live there). Clone github.com/slimepriestess/nightwatch, set NIGHTWATCH_REPO to that folder for your desktop session (on Linux, a line NIGHTWATCH_REPO=/path/to/nightwatch in ~/.config/environment.d/nightwatch.conf, then log in again), and restart Nightwatch. Once it opens, Set up makes your first hub, and from then on the app finds the checkout through it.".into()));
    }
    let gui = repo.join("gui"); // the product's own viewer, beside this app in the repo
    let log = std::fs::OpenOptions::new().create(true).append(true).open(gui.join("viewer.log")).map_err(|e| said(e.to_string()))?;
    Command::new(node)
        .arg(gui.join("server.mjs"))
        .env("NIGHTWATCH_PORT", port.to_string())
        .current_dir(&gui)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| said(e.to_string()))?)
        .stderr(log)
        .spawn()
        .map_err(|e| said(format!("couldn't start the viewer server: {e}")))?;
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(10) {
        if server_up_at(port) {
            if replaced.is_some() { log::info!("the new viewer server answers on port {port}, from {}", repo.display()); }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(said(format!("the viewer server started but never answered on {port}")))
}

// What answers on the viewer's port. A viewer since /whoami says who it is;
// one from before it is known by its command line (the app and the old
// launcher both start it by absolute path, so the tree is in the argv). A
// viewer's pid must really be node running a gui/server.mjs before it counts.
#[derive(Debug, Clone, PartialEq)]
enum Answerer {
    Viewer { pid: u32, root: Option<PathBuf>, rev: Option<String>, started: Option<u64> },
    Other { pid: Option<u32>, cmd: String },
}
impl Answerer {
    fn describe(&self) -> String {
        match self {
            Answerer::Viewer { pid, root, rev, started } => format!(
                "pid {pid}, tree {}, rev {}, {}",
                root.as_ref().map_or("unknown".into(), |r| r.display().to_string()),
                rev.as_deref().map_or("unknown", |r| &r[..r.len().min(12)]),
                if started.is_some() { "answers /whoami" } else { "from before /whoami" }
            ),
            Answerer::Other { pid, cmd } => format!("pid {}, {}", pid.map_or("unknown".into(), |p| p.to_string()), if cmd.is_empty() { "command unknown" } else { cmd }),
        }
    }
}

#[derive(Debug, PartialEq)]
enum Verdict { Keep, Replace(u32, String), Refuse(String) }

// The rule, kept pure for its tests. `alive`: the answering viewer's tree is
// still a tree on disk. `newest_code`: this tree's newest code file, ms.
// Replace this tree's own viewer when its code changed after it started (or it
// predates /whoami, so nobody can tell), and a viewer whose tree is gone.
// Never kill another living tree's viewer: two hubs sharing a port would
// otherwise each kill the other's healthy server on every launch (Weft, 10/21).
fn judge(a: &Answerer, repo: &Path, newest_code: u64, alive: bool, port: u16) -> Verdict {
    let Answerer::Viewer { pid, root, started, .. } = a else {
        return Verdict::Refuse(format!("Port {port} is taken by something that isn't a Nightwatch viewer ({}), so the viewer can't start there. Stop it, or give Nightwatch another port with NIGHTWATCH_PORT.", a.describe()));
    };
    let Some(root) = root else {
        return Verdict::Refuse(format!("Port {port} is held by a Nightwatch viewer whose tree can't be told ({}). Quit it (pid {pid}) and reopen Nightwatch.", a.describe()));
    };
    if canon(root) == canon(repo) {
        return match started {
            Some(s) if *s >= newest_code => Verdict::Keep,
            Some(_) => Verdict::Replace(*pid, "this tree's code changed after it started".into()),
            None => Verdict::Replace(*pid, "it predates /whoami, so its code can't be checked".into()),
        };
    }
    if !alive {
        return Verdict::Replace(*pid, format!("its tree {} is gone", root.display()));
    }
    Verdict::Refuse(format!("Port {port} already serves the Nightwatch viewer from {}, and this app runs from {}. Nightwatch won't stop another tree's living viewer: quit that one (pid {pid}), or give one of them its own NIGHTWATCH_PORT.", root.display(), repo.display()))
}

fn answerer_on(port: u16) -> Answerer {
    let who = http_get(port, "/whoami")
        .filter(|(code, _)| *code == 200)
        .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(&body).ok())
        .filter(|j| j.get("nightwatch").and_then(|v| v.as_str()) == Some("viewer"));
    let pid = match &who {
        Some(j) => j.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32),
        None => listener_pid(port),
    };
    let Some(pid) = pid else { return Answerer::Other { pid: None, cmd: String::new() } };
    let cmd = command_of(pid);
    let Some(argv_root) = viewer_root_in(&cmd) else { return Answerer::Other { pid: Some(pid), cmd } };
    match who {
        Some(j) => Answerer::Viewer {
            pid,
            root: j.get("root").and_then(|v| v.as_str()).map(PathBuf::from),
            rev: j.get("rev").and_then(|v| v.as_str()).map(String::from),
            started: j.get("started").and_then(|v| v.as_u64()),
        },
        None => Answerer::Viewer { pid, root: argv_root, rev: None, started: None },
    }
}

// A viewer's command line is node running some gui/server.mjs: Some(its tree,
// when the path is absolute) for a viewer, None for anything else.
fn viewer_root_in(cmd: &str) -> Option<Option<PathBuf>> {
    let mut words = cmd.split_whitespace();
    if !words.next().is_some_and(|w| w.rsplit('/').next() == Some("node")) { return None; }
    let script = words.find(|w| *w == "server.mjs" || w.ends_with("/gui/server.mjs"))?;
    Some(script.strip_suffix("/gui/server.mjs").filter(|t| t.starts_with('/')).map(PathBuf::from))
}

fn command_of(pid: u32) -> String {
    Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "command="]).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

// The pid listening on the port, for a viewer too old to say: lsof (macOS has
// it; most Linux too), else ss.
fn listener_pid(port: u16) -> Option<u32> {
    for lsof in ["/usr/sbin/lsof", "/usr/bin/lsof"] {
        if !Path::new(lsof).is_file() { continue; }
        let out = Command::new(lsof).args(["-nP", "-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"]).output().ok()?;
        return String::from_utf8_lossy(&out.stdout).lines().next()?.trim().parse().ok();
    }
    let out = Command::new("ss").args(["-ltnpH", &format!("sport = :{port}")]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    s[s.find("pid=")? + 4..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

fn http_get(port: u16, path: &str) -> Option<(u16, String)> {
    use std::io::{Read, Write};
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(s, "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n")?;
    Some((head.split_whitespace().nth(1)?.parse().ok()?, body.to_string()))
}

// The newest code file the viewer loads (gui's and machinery's modules), in
// ms since the epoch: a server that started before it runs older code.
fn newest_code(repo: &Path) -> u64 {
    ["gui", "machinery"].iter().filter_map(|d| std::fs::read_dir(repo.join(d)).ok()).flatten().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "mjs"))
        .filter_map(|e| e.metadata().and_then(|m| m.modified()).ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64).max().unwrap_or(0)
}

// Stop a viewer and wait for its port to free.
fn stop_server(pid: u32, port: u16) -> bool {
    let _ = Command::new("/bin/kill").arg(pid.to_string()).status();
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) {
        if !server_up_at(port) { return true; }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

// Bring the window back from hidden or minimized, covering the screen first,
// as the tray's toggle does when it shows it.
//
// On WSL a window minimized from the Windows taskbar stays down: WSLg never
// tells the X11 side (is_visible true, is_minimized false) and ignores
// unminimize(). Unmapping and mapping it again brings it back; on a window
// that was already up, that costs at most a brief flicker (Terra, 10/20).
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        cover(&w);
        if on_wsl() { let _ = w.hide(); }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            cover(&w);
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

// ---------------------------------------------------------------- actions
// The page's write buttons arrive here through window.NW_HOST.act (contract
// v0.8). Built one at a time, safest first (Ra, 10/6): hide-window, then
// wake. Anything not listed in HOST_CAN stays read-only in the page.
#[cfg(target_os = "macos")]
const HOST_CAN: &[&str] = &["hide-window", "wake", "sleep", "retry-wake", "open-terminal", "hide-terminal", "terminal-state", "wake-all", "sleep-all", "restore-checkpoint", "restart-daemon",
    "save-lane", "save-settings", "toggle-nightly", "arm-lane", "toggle-midday", "remove-lane", "emergency-fold", "fold-all", "run-doctor"];
// Off macOS a lane's terminal can't be found or raised: Terminal tabs are
// found by tty through AppleScript, and the Linux answer is "don't" (a wrong
// window raised is worse than none, nightwatch#2). Those buttons stay
// read-only in the page; everything else is wired.
#[cfg(not(target_os = "macos"))]
const HOST_CAN: &[&str] = &["hide-window", "wake", "sleep", "retry-wake", "wake-all", "sleep-all", "restore-checkpoint", "restart-daemon",
    "save-lane", "save-settings", "toggle-nightly", "arm-lane", "toggle-midday", "remove-lane", "emergency-fold", "fold-all", "run-doctor"];

// The product's own source tree (the repo this app was built from): its gui/
// serves the page and its machinery/ is what Set up points new hubs at.
const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
// Where the source tree comes from, in order: NIGHTWATCH_REPO when it's set
// (an absolute path; this overrides the built tree on macOS too, for the
// rare launch whose environment carries it), then the tree this app was
// built from, while it's still there (every local build, macOS's install.sh
// among them), then the tree a registered hub's machinery lives in, for a
// bundle built somewhere else (a Linux package from CI). A candidate counts
// only if it holds both the viewer and the machinery. Decided once per run
// and logged with its reason, so the viewer the app started and a later Set
// up can't disagree about which tree is Nightwatch.
fn repo() -> PathBuf {
    static REPO_CHOICE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    REPO_CHOICE.get_or_init(|| {
        let candidates = repo_candidates(std::env::var("NIGHTWATCH_REPO").ok(), Path::new(REPO), &all_hub_roots());
        let found: Vec<&(PathBuf, String)> = candidates.iter().filter(|(p, _)| is_repo(p)).collect();
        match found.first() {
            Some((p, why)) => {
                log::info!("source tree: {} ({why})", p.display());
                let others: Vec<String> = found.iter().skip(1).map(|(q, _)| canon(q)).filter(|q| *q != canon(p)).map(|q| q.display().to_string()).collect();
                if !others.is_empty() { log::warn!("other Nightwatch trees found, not used: {}", others.join(", ")); }
                canon(p)
            }
            None => {
                log::error!("no source tree found (NIGHTWATCH_REPO unset or not a tree, the built tree {REPO} gone, no registered hub pointing at one)");
                canon(Path::new(REPO))
            }
        }
    }).clone()
}
fn repo_candidates(env: Option<String>, built: &Path, hubs: &[PathBuf]) -> Vec<(PathBuf, String)> {
    let mut c: Vec<(PathBuf, String)> = env.filter(|e| e.starts_with('/')).map(|e| (PathBuf::from(e), "NIGHTWATCH_REPO".to_string())).into_iter().collect();
    c.push((built.to_path_buf(), "the tree this app was built from".into()));
    for root in hubs {
        // The machinery's own location, a symlinked one followed to its target.
        if let Some(p) = Hub::open(root).ok().and_then(|h| canon(&h.machinery).parent().map(Path::to_path_buf)) {
            c.push((p, format!("the tree {} runs from", root.display())));
        }
    }
    c
}
fn is_repo(p: &Path) -> bool { p.join("gui/server.mjs").is_file() && p.join("machinery/nightshift.mjs").is_file() }
fn app_machinery() -> PathBuf { repo().join("machinery") }

// ---------------------------------------------------------------- hubs
// A hub is one persona's folder: the legacy house's at ~/origin/weft, Set up's at
// ~/Nightwatch/<slug>. The app finds them in the machine's registry (Fable's
// machinery writes it; the app only reads). Every action acts in one hub, and
// that hub must be one the app shows: the page can never point a script at an
// arbitrary folder. No registry yet: the one default hub, as before.
struct Hub {
    root: PathBuf,
    config_file: PathBuf,
    cfg: serde_json::Value,
    machinery: PathBuf, // the code it runs (paths.machinery; our legacy hub keeps its own wakecycle/)
    state: PathBuf,     // its receipts, lane registry, armed file (paths.wakecycle)
}

// The machine's hub registry, where machinery/platform.mjs registryFile() puts
// it: Application Support on macOS, $XDG_CONFIG_HOME/nightwatch (or
// ~/.config/nightwatch) elsewhere. It was the macOS path on every platform
// (issue #6). NIGHTWATCH_REGISTRY overrides it for benches. Its twin is
// registryFile() in machinery/platform.mjs: change one, change both.
fn registry_file() -> PathBuf {
    if let Ok(p) = std::env::var("NIGHTWATCH_REGISTRY") {
        return PathBuf::from(p);
    }
    let dir = if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Nightwatch")
    } else {
        match std::env::var("XDG_CONFIG_HOME") {
            Ok(x) if !x.is_empty() => PathBuf::from(x).join("nightwatch"),
            _ => home().join(".config/nightwatch"),
        }
    };
    dir.join("hubs.json")
}

fn registered_hubs() -> Vec<PathBuf> {
    let Ok(raw) = std::fs::read_to_string(registry_file()) else { return vec![] };
    let Ok(j) = serde_json::from_str::<serde_json::Value>(&raw) else { return vec![] };
    j.get("hubs").and_then(|h| h.as_array()).map(|a| a.iter()
        .filter_map(|h| h.get("path").and_then(|p| p.as_str()))
        .filter(|p| p.starts_with('/')).map(PathBuf::from).collect()).unwrap_or_default()
}

// The hubs the app shows: the registry's, and only those. An empty registry
// is a machine with nothing set up yet (Set up), never a guess at one
// house's folder (issue #7).
fn all_hub_roots() -> Vec<PathBuf> {
    registered_hubs()
}

fn canon(p: &Path) -> PathBuf { std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()) }

// A path bound for an AppleScript string and a shell command line.
fn plain_path(p: &Path) -> Result<String, String> {
    let s = p.to_string_lossy().to_string();
    if s.chars().any(|c| matches!(c, '"' | '\\' | '$' | '`' | '\n' | '\r')) { Err(format!("{s} has characters the app won't put in a command.")) } else { Ok(s) }
}

fn rel_to(root: &Path, v: Option<&str>, fallback: &str) -> PathBuf {
    match v { Some(s) if s.starts_with('/') => PathBuf::from(s), Some(s) => root.join(s), None => root.join(fallback) }
}

impl Hub {
    fn open(root: &Path) -> Result<Hub, String> {
        let nw = root.join("nightwatch.config.json");
        let config_file = if nw.is_file() { nw } else { root.join("weft.config.json") };
        let raw = std::fs::read_to_string(&config_file).map_err(|e| format!("can't read {}: {e}", config_file.display()))?;
        let cfg: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("{} doesn't parse: {e}", config_file.display()))?;
        let path = |k: &str| cfg.get("paths").and_then(|p| p.get(k)).and_then(|v| v.as_str()).map(String::from);
        let machinery = rel_to(root, path("machinery").as_deref(), "wakecycle");
        let state = rel_to(root, path("wakecycle").as_deref(), "wakecycle");
        Ok(Hub { root: root.to_path_buf(), config_file, cfg, machinery, state })
    }
    fn name(&self) -> String {
        self.cfg.get("persona").and_then(|p| p.get("name")).and_then(|v| v.as_str()).map(String::from)
            .unwrap_or_else(|| self.root.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default())
    }
    fn lanes(&self) -> Vec<String> {
        self.cfg.get("lanes").and_then(|l| l.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default()
    }
    // A lane name ends up inside an AppleScript string, so it must be a lane
    // this hub's config knows, spelled plainly. (A typo must never become a
    // default: the --help fold of 10/5.)
    fn check_lane(&self, lane: Option<&str>) -> Result<String, String> {
        let lane = lane.ok_or("no agent given")?;
        let plain = !lane.is_empty() && lane.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let known = self.cfg.get("lanes").and_then(|l| l.get(lane)).is_some();
        if plain && known { Ok(lane.to_string()) } else { Err(format!("\"{lane}\" isn't one of {}'s agents", self.name())) }
    }
    // The nightshift's job: Set up's per-hub one (its copy in the state dir),
    // else on Linux the installed unit that runs this hub's config (a hub set
    // up by hand has no state-dir copy; found on WSL, 10/20), else on macOS
    // our legacy launchd job. None when there is no job to name.
    fn daemon_label(&self) -> Option<String> { self.daemon_label_in(&systemd_user_dir()) }
    fn daemon_label_in(&self, units_dir: &Path) -> Option<String> {
        let staged = std::fs::read_dir(&self.state).ok().into_iter().flatten().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|n| n.starts_with("house.nightwatch.") && (n.ends_with(".plist") || n.ends_with(".service")))
            .map(|n| n.trim_end_matches(".plist").trim_end_matches(".service").to_string());
        if staged.is_some() { return staged; }
        if cfg!(target_os = "macos") { return Some("com.weft.nightshift".into()); }
        let units: Vec<(String, String)> = std::fs::read_dir(units_dir).ok().into_iter().flatten().flatten()
            .map(|e| (e.file_name().to_string_lossy().to_string(), std::fs::read_to_string(e.path()).unwrap_or_default()))
            .collect();
        unit_for_config(&units, &self.config_file).or_else(|| unit_for_config(&units, &canon(&self.config_file)))
    }
    // Every CLI runs this hub's machinery against this hub's config.
    fn node(&self, script: &str, args: &[&str]) -> Result<String, String> {
        let node = find_node().ok_or("node not found")?;
        let out = Command::new(node).arg(self.machinery.join(script)).args(args)
            .env("NIGHTWATCH_CONFIG", &self.config_file).env_remove("WEFT_CONFIG").current_dir(&self.root)
            .output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) }
        else { Err(String::from_utf8_lossy(&out.stderr).trim().replace("refused: ", "").to_string()) }
    }
}

// The hub an action names. None: the first one the app shows.
fn hub(sel: Option<&str>) -> Result<Hub, String> { hub_among(sel, all_hub_roots()) }
fn hub_among(sel: Option<&str>, roots: Vec<PathBuf>) -> Result<Hub, String> {
    let root = match sel {
        None => roots.first().cloned().ok_or("Nightwatch has no hub yet.")?,
        Some(s) => {
            let want = canon(Path::new(s));
            roots.into_iter().find(|r| canon(r) == want).ok_or(format!("{s} isn't a hub Nightwatch knows (it isn't in the registry)."))?
        }
    };
    Hub::open(&root)
}

// The receipt the wake would resume, and the session it was folded from.
fn receipt_sessions(h: &Hub, lane: &str) -> Result<Vec<String>, String> {
    let p = h.state.join(format!("next-wake.{lane}.json"));
    let raw = std::fs::read_to_string(&p).map_err(|_| format!("{lane} has no sleep receipt (next-wake.{lane}.json); did they sleep?"))?;
    let j: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("next-wake.{lane}.json doesn't parse: {e}"))?;
    Ok(["sessionId", "from"].iter().filter_map(|k| j.get(*k).and_then(|v| v.as_str()).map(String::from)).collect())
}

// wake.sh has no "already awake" guard (the nightshift checks before it
// launches), so this one does: two live resumes of one transcript would
// interleave a single history.
fn live_resume(ps_out: &str, sessions: &[String]) -> Option<String> {
    sessions.iter().find(|s| ps_out.lines().any(|l| l.contains("claude") && l.contains(&format!("--resume {s}")))).cloned()
}

fn wake(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    let sessions = receipt_sessions(h, &lane)?;
    // Every process's full command line: BSD ps on macOS, procps on Linux
    // (where -e means every process; on macOS it adds the environment).
    let (ps_bin, ps_args): (&str, &[&str]) = if cfg!(target_os = "macos") { ("/bin/ps", &["-axo", "command"]) } else { ("ps", &["-eo", "args"]) };
    let ps = Command::new(ps_bin).args(ps_args).output().map_err(|e| e.to_string())?;
    if let Some(s) = live_resume(&String::from_utf8_lossy(&ps.stdout), &sessions) {
        return Err(format!("{lane} is already awake (a session is resuming {}).", &s[..8.min(s.len())]));
    }
    // Off macOS the machinery opens the window (nightwatch#2): the daemon's
    // own launcher, a terminal emulator or tmux on Linux and wt.exe on WSL.
    if !cfg!(target_os = "macos") {
        return h.node("nightshift.mjs", &["--wake", &lane]).map_err(|e| e.replace("--wake: ", ""));
    }
    // Exactly what the nightshift does at 08:00, so the wake is the same wake:
    // this hub's wake.sh, against this hub's config.
    let script = plain_path(&h.machinery.join("wake.sh"))?;
    let cfg = plain_path(&h.config_file)?;
    let run = |src: String| Command::new("/usr/bin/osascript").args(["-e", &src]).output();
    let out = run(format!("tell application \"Terminal\" to do script \"NIGHTWATCH_CONFIG=\\\"{cfg}\\\" \\\"{script}\\\" {lane}\"")).map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Terminal didn't open: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let _ = run("tell application \"Terminal\" to activate".into());
    Ok(format!("Waking {lane}: a Terminal window is resuming them."))
}

// ---------------------------------------------------------------- click-through
// The window is a transparent rectangle, but the app's silhouette isn't, and
// clear pixels still catch clicks. The page reports where its modules are
// (CSS px, viewport-relative); a watcher makes the window ignore the mouse
// whenever the pointer is over none of them, so clicks reach what's behind.
static HIT: Mutex<Vec<[f64; 4]>> = Mutex::new(Vec::new());

#[tauri::command]
fn set_hit_rects(rects: Vec<[f64; 4]>) {
    log::info!("hit areas: {} modules", rects.len());
    *HIT.lock().unwrap() = rects;
}

// rects are [x, y, w, h] in CSS px; (cx, cy) is the pointer in the same space.
fn over_module(rects: &[[f64; 4]], cx: f64, cy: f64) -> bool {
    rects.iter().any(|r| cx >= r[0] - 2.0 && cx <= r[0] + r[2] + 2.0 && cy >= r[1] - 2.0 && cy <= r[1] + r[3] + 2.0)
}

fn watch_pointer(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let Some(w) = app.get_webview_window("main") else { continue };
            if !w.is_visible().unwrap_or(false) { continue; }
            tick = tick.wrapping_add(1);
            if tick % 50 == 0 { cover(&w); } // ~2s: follow Dock and resolution changes
            let (Ok(cur), Ok(pos), Ok(scale)) = (app.cursor_position(), w.inner_position(), w.scale_factor()) else { continue };
            let rects = HIT.lock().unwrap().clone();
            // The window covers the screen, so until the page has said where its modules are, clicks pass
            // through: a page that fails to load must never make the whole desktop unclickable.
            let ignore = rects.is_empty() || !over_module(&rects, (cur.x - pos.x as f64) / scale, (cur.y - pos.y as f64) / scale);
            if ignoring != Some(ignore) {
                let _ = w.set_ignore_cursor_events(ignore);
                ignoring = Some(ignore);
            }
        }
    });
}

// Sleep rings the lane's bell by hand: the nightshift's own ringBell via its
// --ring CLI (same spool note, same ritual, event source "nightwatch"), so
// the app never keeps a second copy of the ritual.
fn sleep(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    match h.node("nightshift.mjs", &["--ring", &lane]) {
        // A nearly full window gets no bell (nightwatch#56): the CLI says what happens instead.
        Ok(out) if out.contains("too full for the bedtime ritual") => Ok(out),
        Ok(_) => Ok(format!("Rang {lane}'s bell. If the agent is listening, the rung gets written and the fold runs; if not, the nightshift folds the session after the grace period.")),
        Err(e) => Err(e.replace("--ring: ", "")),
    }
}

// The window is a transparent canvas over the display's usable area (below
// the menu bar, above the Dock); the page places the app inside it and
// clicks pass through everywhere but the modules (watch_pointer). Ra, 10/6:
// sizing the window to hug the panels, and growing it for every menu,
// dialog and tooltip, kept cutting things off ("there's prolly a more
// elegant method"). A canvas can't cut a menu off, so nothing has to be
// measured. Re-checked every couple of seconds, so a Dock or resolution
// change is followed.
fn work_area(win: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let m = win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten())?;
    let s = m.scale_factor();
    let wa = m.work_area();
    Some((wa.position.x as f64 / s, wa.position.y as f64 / s, wa.size.width as f64 / s, wa.size.height as f64 / s))
}
// The work area last asked for. cover() compares the new one against this,
// not against the window's own geometry read back: what a window reports
// depends on the window manager. On WSLg's X server the readback carries the
// frame extents ((-38,-59) 2636x1537 for a (0,0) 2560x1440 canvas), so it
// never matched and the canvas was re-set every tick (10/20).
static COVERED: Mutex<Option<[f64; 4]>> = Mutex::new(None);
fn already_covered(last: Option<[f64; 4]>, want: [f64; 4]) -> bool {
    last.is_some_and(|l| l.iter().zip(want).all(|(a, b)| (a - b).abs() < 1.0))
}
fn cover(win: &tauri::WebviewWindow) {
    let Some((x, y, w, h)) = work_area(win) else { log::warn!("canvas: no monitor to cover"); return };
    let mut last = COVERED.lock().unwrap();
    if already_covered(*last, [x, y, w, h]) { return; }
    let s = win.scale_factor().unwrap_or(1.0);
    let (at, size) = (win.outer_position().map(|p| p.to_logical::<f64>(s)), win.outer_size().map(|z| z.to_logical::<f64>(s)));
    log::info!("canvas: window {:?} {:?} -> covering the work area", at.as_ref().ok().map(|p| (p.x.round(), p.y.round())), size.as_ref().ok().map(|z| (z.width.round(), z.height.round())));
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    let _ = win.set_size(tauri::LogicalSize::new(w, h));
    *last = Some([x, y, w, h]);
    log::info!("canvas: {w:.0}x{h:.0} at ({x:.0},{y:.0})");
}

// WSLg offers Wayland, and GTK takes it; but a Wayland client can't learn
// where its window is (outer_position reads (0,0)), so on two monitors
// current_monitor() alternated and cover() flipped the canvas between them
// every tick: the whole window flickered (10/20). Under X11 the canvas holds
// still. Only on WSL, and never over a backend someone chose.
fn wsl_wants_x11(wsl: bool, gdk_backend: Option<std::ffi::OsString>) -> bool {
    wsl && gdk_backend.is_none()
}

// Restart (Ra, 10/6: Nightwatch stays running, so updates need a way in).
// Relaunch the .app bundle through LaunchServices (`open`) once this copy
// has exited, so a freshly installed build is what starts, under the app's
// own identity and permissions. It waits for this process to be gone, not a
// fixed second: with single-instance, a new copy that started while this one
// was still exiting would hand itself to the dying one and quit, leaving no
// Nightwatch at all. Outside a bundle (dev), Tauri's own restart, which
// releases the single-instance lock before it starts the new copy.
fn bundle_of(exe: &std::path::Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(|p| p.to_path_buf())
}
// $1 is this process's pid, $0 the bundle. A minute's cap, so a copy that
// never exits can't leave the relaunch waiting forever.
const WAIT_FOR_EXIT: &str = "i=0; while kill -0 \"$1\" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done";
fn relaunch_script() -> String { format!("{WAIT_FOR_EXIT}; /usr/bin/open \"$0\"") }
fn restart_app(app: &AppHandle) {
    let Some(bundle) = std::env::current_exe().ok().as_deref().and_then(bundle_of) else { app.restart() };
    let _ = Command::new("/bin/sh").arg("-c").arg(relaunch_script()).arg(&bundle).arg(std::process::id().to_string())
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
    app.exit(0);
}

#[cfg(test)]
mod relaunch_tests {
    use super::*;
    use std::time::{Duration, Instant};
    // The relaunch waits for the copy that asked for it to be gone (it may take
    // longer than a second to exit), and doesn't wait at all for one already
    // gone. Driven through /bin/sh with a real child, as restart_app runs it.
    fn waited(pid: u32) -> Duration {
        let t = Instant::now();
        let ok = Command::new("/bin/sh").arg("-c").arg(WAIT_FOR_EXIT).arg("bundle").arg(pid.to_string()).status().unwrap();
        assert!(ok.success());
        t.elapsed()
    }
    #[test]
    fn the_relaunch_waits_for_the_old_copy_to_exit() {
        let mut child = Command::new("/bin/sleep").arg("1.5").spawn().unwrap();
        let pid = child.id();
        let reaper = std::thread::spawn(move || child.wait());
        let took = waited(pid);
        reaper.join().unwrap().unwrap();
        assert!(took >= Duration::from_millis(1200), "returned after {took:?}, while the old copy was still running");
        assert!(took < Duration::from_secs(5), "kept waiting after it exited: {took:?}");
    }
    #[test]
    fn the_relaunch_goes_at_once_when_the_old_copy_is_gone() {
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(waited(pid) < Duration::from_millis(500));
    }
    #[test]
    fn the_relaunch_opens_the_bundle_after_the_wait() {
        let s = relaunch_script();
        assert!(s.starts_with(WAIT_FOR_EXIT) && s.ends_with("; /usr/bin/open \"$0\""), "{s}");
    }
}

#[cfg(test)]
mod repo_tests {
    use super::*;
    fn make_tree(t: &Path, name: &str) -> PathBuf {
        let tree = t.join(name);
        std::fs::create_dir_all(tree.join("gui")).unwrap();
        std::fs::create_dir_all(tree.join("machinery")).unwrap();
        std::fs::write(tree.join("gui/server.mjs"), "").unwrap();
        std::fs::write(tree.join("machinery/nightshift.mjs"), "").unwrap();
        tree
    }
    fn hub_at(t: &Path, name: &str, tree: &Path) -> PathBuf {
        let hub = t.join(name);
        std::fs::create_dir_all(&hub).unwrap();
        std::fs::write(hub.join("nightwatch.config.json"), format!(r#"{{"paths":{{"machinery":"{}"}}}}"#, tree.join("machinery").display())).unwrap();
        hub
    }
    fn first_tree(c: Vec<(PathBuf, String)>) -> Option<PathBuf> { c.into_iter().map(|(p, _)| p).find(|p| is_repo(p)) }

    // A bundle built elsewhere: its baked-in tree is gone, and the person's
    // own checkout is found through the hub that points at it.
    #[test]
    fn finds_the_tree_through_a_registered_hub_when_the_built_one_is_gone() {
        let t = std::env::temp_dir().join(format!("nw-repo-test-a-{}", std::process::id()));
        let tree = make_tree(&t, "checkout");
        let hub = hub_at(&t, "hub", &tree);
        let gone = t.join("ci-runner/nightwatch");
        assert_eq!(first_tree(repo_candidates(None, &gone, &[hub])), Some(canon(&tree)));
        // A half tree (machinery without the viewer) isn't a tree.
        std::fs::remove_file(tree.join("gui/server.mjs")).unwrap();
        assert!(!is_repo(&tree));
        let _ = std::fs::remove_dir_all(&t);
    }

    // The order: NIGHTWATCH_REPO over a real built tree, the built tree over
    // a hub's, and a relative NIGHTWATCH_REPO is never a candidate at all.
    #[test]
    fn the_order_is_env_then_built_then_hubs() {
        let t = std::env::temp_dir().join(format!("nw-repo-test-b-{}", std::process::id()));
        let env_tree = make_tree(&t, "env-tree");
        let built = make_tree(&t, "built-tree");
        let hub_tree = make_tree(&t, "hub-tree");
        let hub = hub_at(&t, "hub", &hub_tree);
        assert_eq!(first_tree(repo_candidates(Some(env_tree.display().to_string()), &built, &[hub.clone()])), Some(env_tree.clone()));
        assert_eq!(first_tree(repo_candidates(None, &built, &[hub.clone()])), Some(built.clone()));
        let c = repo_candidates(Some("relative/env-tree".into()), &built, &[]);
        assert!(c.iter().all(|(p, _)| p.is_absolute()), "{c:?}");
        assert_eq!(c.len(), 1);
        let _ = std::fs::remove_dir_all(&t);
    }

    // A first Set up: the new hub's config path, and a working folder that
    // exists (the nearest one above a hub that isn't there yet).
    #[test]
    fn a_first_set_up_runs_from_the_new_hubs_own_config() {
        let t = std::env::temp_dir().join(format!("nw-first-hub-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        let target = t.join("not-yet/the-hub");
        let h = first_hub(&serde_json::json!({ "op": "init", "hub": target.display().to_string() })).unwrap();
        assert_eq!(h.config_file, target.join("nightwatch.config.json"));
        assert_eq!(h.root, t);
        assert!(h.root.is_dir());
        // ~/ means home; a relative folder is refused rather than guessed at.
        assert_eq!(first_hub(&serde_json::json!({ "hub": "~/my-hub" })).unwrap().config_file, home().join("my-hub/nightwatch.config.json"));
        assert!(first_hub(&serde_json::json!({ "hub": "my-hub" })).is_none());
        assert!(first_hub(&serde_json::json!({})).is_none());
        let _ = std::fs::remove_dir_all(&t);
    }

    // The first-hub path opens for exactly one case.
    #[test]
    fn only_a_first_set_up_on_an_empty_machine_takes_the_first_hub_path() {
        assert!(first_setup_allowed(true, None, true));
        assert!(!first_setup_allowed(false, None, true), "adding an agent");
        assert!(!first_setup_allowed(true, Some("/h"), true), "a named hub");
        assert!(!first_setup_allowed(true, None, false), "a machine that has hubs");
    }
}

#[cfg(test)]
mod restart_tests {
    use super::bundle_of;
    #[test]
    fn finds_the_app_bundle_above_the_binary() {
        let p = std::path::Path::new("/Users/x/Applications/Nightwatch.app/Contents/MacOS/app");
        assert_eq!(bundle_of(p).unwrap(), std::path::PathBuf::from("/Users/x/Applications/Nightwatch.app"));
        assert!(bundle_of(std::path::Path::new("/tmp/target/debug/app")).is_none());
    }
    // nvm's newest node is picked by version, not by name: v22 above v9.
    #[test]
    fn nvm_versions_sort_by_number() {
        let v = |s: &str| super::node_version(&std::path::PathBuf::from(format!("/h/.nvm/versions/node/{s}/bin/node")));
        assert_eq!(v("v22.21.1"), vec![22, 21, 1]);
        assert!(v("v22.0.0") > v("v9.11.2"));
        assert!(v("v22.21.1") > v("v22.3.0"));
    }
}

// Keep on top is the viewer's choice (View menu), off unless they ask.
#[tauri::command]
fn set_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no window")?;
    win.set_always_on_top(on).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- batch 2
// Paths come from the hub's one authority (config.mjs get), never from a
// remembered path: a wrong-but-plausible checkpoint path cost the 10/5 morning.
fn cfg_get(h: &Hub, key: &str) -> Result<String, String> {
    let v = h.node("config.mjs", &["get", key]).map_err(|_| format!("config has no {key}"))?;
    if v.is_empty() { return Err(format!("config has no {key}")); }
    Ok(v)
}

// The lane's live Claude Code process: the newest registry entry for the lane
// whose pid is alive AND is actually claude (a recycled pid isn't the lane).
fn lane_pid(h: &Hub, lane: &str) -> Option<u32> {
    let mut best: Option<(std::time::SystemTime, u32)> = None;
    for e in std::fs::read_dir(&h.state).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("lane.") { continue; }
        let Ok(raw) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(j) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        if j.get("lane").and_then(|v| v.as_str()) != Some(lane) { continue; }
        let Some(pid) = j.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32) else { continue };
        let cmd = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "command="]).output().ok()?;
        if !String::from_utf8_lossy(&cmd.stdout).contains("claude") { continue; }
        let t = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if best.map_or(true, |(bt, _)| t > bt) { best = Some((t, pid)); }
    }
    best.map(|(_, p)| p)
}

// The lane's own Terminal tab, found by its tty (Ra, 10/7: "Bring terminal to
// front" flips to "Hide terminal" while the window is showing). One script,
// three verbs: show (un-minimize, select the tab, raise, activate), hide
// (minimize its window) and state ("front", "open", "hidden" or "missing").
// Every verb checks that Terminal is running first: a state query must never
// launch Terminal just to report that nothing is open.
// What each verb does once the lane's tab is found (w = its window, t = the tab).
fn terminal_body(verb: &str) -> &'static str {
    match verb {
        "show" => "set miniaturized of w to false\n        set selected of t to true\n        set index of w to 1\n        activate\n        return \"found\"",
        "hide" => "set miniaturized of w to true\n        return \"found\"",
        _ => "if miniaturized of w then return \"hidden\"\n        if frontmost and index of w is 1 then return \"front\"\n        return \"open\"",
    }
}

fn lane_terminal(h: &Hub, lane: Option<&str>, verb: &str) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    // Not in HOST_CAN off macOS, so the page never asks; a caller that does
    // gets a plain answer rather than an AppleScript error.
    if !cfg!(target_os = "macos") {
        let _ = verb;
        return Err(format!("Bringing {lane}'s terminal forward works on macOS only; bring it forward yourself."));
    }
    let pid = lane_pid(h, &lane).ok_or(format!("{lane} has no live session to show."))?;
    let out = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "tty="]).output().map_err(|e| e.to_string())?;
    let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if tty.is_empty() || tty == "??" { return Err(format!("{lane}'s session has no terminal (pid {pid}).")); }
    let body = terminal_body(verb);
    let script = format!(r#"if application "Terminal" is not running then return "missing"
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/{tty}" then
        {body}
      end if
    end repeat
  end repeat
  return "missing"
end tell"#);
    let out = Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
    let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match (verb, said.as_str()) {
        ("state", s) => Ok(s.to_string()),
        (_, "found") => Ok(String::new()),
        _ => Err(format!("{lane}'s session isn't in a Terminal window (it may be in another terminal app).")),
    }
}

// Every lane of every hub the app shows, one at a time, each through its own
// guards; the summary names what happened to each, refusals included, never
// a bare "done". With several personas, lanes are named with their persona.
fn for_all(f: fn(&Hub, Option<&str>) -> Result<String, String>, quiet_refusal: &str) -> Result<String, String> {
    let roots = all_hub_roots();
    let several = roots.len() > 1;
    let mut done = Vec::new();
    let mut refused = Vec::new();
    for root in roots {
        let h = match Hub::open(&root) { Ok(h) => h, Err(e) => { refused.push(e); continue; } };
        for lane in h.lanes() {
            let who = if several { format!("{} {lane}", h.name()) } else { lane.clone() };
            match f(&h, Some(&lane)) {
                Ok(_) => done.push(who),
                Err(e) if e.contains(quiet_refusal) || e.contains("no sleep receipt") => {}
                Err(e) => refused.push(format!("{who}: {e}")),
            }
        }
    }
    let mut msg = if done.is_empty() { "Nothing to do.".to_string() } else { done.join(", ") + "." };
    if !refused.is_empty() { msg += &format!(" Not done: {}", refused.join("; ")); }
    if refused.is_empty() { Ok(msg) } else { Err(msg) }
}

// Only when the canonical checkpoint is MISSING; only from strictly
// timestamp-named archives (YYYY-MM-DD-HHMM.md). The archive also holds a
// decoy and a stray copy from 10/5, and one wrong pick repeats that morning.
fn is_archive_name(n: &str) -> bool {
    let b = n.as_bytes();
    n.len() == 18 && n.ends_with(".md") && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 13, 14].iter().all(|&i| b[i].is_ascii_digit())
        && b[4] == b'-' && b[7] == b'-' && b[10] == b'-'
}
fn restore_checkpoint(h: &Hub) -> Result<String, String> {
    let cp = PathBuf::from(cfg_get(h, "paths.checkpoint")?);
    if cp.exists() { return Err(format!("The checkpoint is already there ({}); nothing was replaced.", cp.display())); }
    let dir = PathBuf::from(cfg_get(h, "paths.ladder")?).join("checkpoints");
    let newest = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten()
        .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_archive_name(n)).max()
        .ok_or("No timestamped checkpoint archive to restore from.")?;
    std::fs::copy(dir.join(&newest), &cp).map_err(|e| e.to_string())?;
    Ok(format!("Restored the checkpoint from {newest}."))
}

// Where platform.mjs's daemonJob installs a systemd user unit: NW_INSTALL_DIR
// for benches, else ~/.config/systemd/user. Change one, change both.
fn systemd_user_dir() -> PathBuf {
    std::env::var_os("NW_INSTALL_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".config/systemd/user"))
}

// The nightshift unit (not the .watch one) whose environment names this
// config, as daemonJob writes it: "NIGHTWATCH_CONFIG=<path>", % doubled; a
// hand-made unit may still say WEFT_CONFIG.
fn unit_for_config(units: &[(String, String)], cfg: &Path) -> Option<String> {
    let want = cfg.to_string_lossy().replace('%', "%%");
    units.iter()
        .filter(|(n, _)| n.starts_with("house.nightwatch.") && n.ends_with(".service") && !n.ends_with(".watch.service"))
        .find(|(_, body)| body.lines().any(|l| l.starts_with("ExecStart=") && l.contains("nightshift.mjs"))
            && ["NIGHTWATCH_CONFIG", "WEFT_CONFIG"].iter().any(|k| body.contains(&format!("\"{k}={want}\""))))
        .map(|(n, _)| n.trim_end_matches(".service").to_string())
}

fn restart_daemon(h: &Hub) -> Result<String, String> {
    let label = h.daemon_label().ok_or_else(|| format!("No nightshift job found for {} (looked in {} and {}).", h.name(), h.state.display(), systemd_user_dir().display()))?;
    // Off macOS the job is a systemd user unit (platform.mjs's daemonJob,
    // which Set up installs as <label>.service).
    if !cfg!(target_os = "macos") {
        let out = Command::new("systemctl").args(["--user", "restart", &format!("{label}.service")])
            .output().map_err(|e| e.to_string())?;
        return if out.status.success() { Ok("Restarted the nightshift. Its heartbeat shows within the minute.".into()) }
            else { Err(format!("systemctl refused: {}", String::from_utf8_lossy(&out.stderr).trim())) };
    }
    let uid = String::from_utf8_lossy(&Command::new("/usr/bin/id").arg("-u").output().map_err(|e| e.to_string())?.stdout).trim().to_string();
    let out = Command::new("/bin/launchctl").args(["kickstart", "-k", &format!("gui/{uid}/{label}")])
        .output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok("Restarted the nightshift. Its heartbeat shows within the minute.".into()) }
    else { Err(format!("launchctl refused: {}", String::from_utf8_lossy(&out.stderr).trim())) }
}

// ---------------------------------------------------------------- batch 3
// Settings writes go through the hub's own CLIs (Fable's): config.mjs
// set/unset (atomic, schema- and consistency-checked before any byte lands)
// and nightshift.mjs --arm/--disarm (comma-joined, unknown lanes refused).
// The app never writes those files itself; it validates first so a bad
// field fails here with a plain sentence instead of as a CLI refusal.
fn cfg_set(h: &Hub, key: &str, v: &serde_json::Value) -> Result<String, String> { h.node("config.mjs", &["set", key, &v.to_string()]) }
fn cfg_unset(h: &Hub, key: &str) -> Result<String, String> { h.node("config.mjs", &["unset", key]) }
fn arm(h: &Hub, lane: &str, on: bool) -> Result<String, String> { h.node("nightshift.mjs", &[if on { "--arm" } else { "--disarm" }, lane]) }

fn hhmm(v: Option<&serde_json::Value>, what: &str) -> Result<String, String> {
    let s = v.and_then(|x| x.as_str()).unwrap_or("");
    let b = s.as_bytes();
    let ok = s.len() == 5 && b[2] == b':' && b[..2].iter().chain(&b[3..]).all(|c| c.is_ascii_digit())
        && s[..2].parse::<u32>().map_or(false, |h| h < 24) && s[3..].parse::<u32>().map_or(false, |m| m < 60);
    if ok { Ok(s.to_string()) } else { Err(format!("{what} must be a time like 02:00 (got \"{s}\").")) }
}
fn target_tokens(v: Option<&serde_json::Value>) -> Result<u64, String> {
    let k = v.and_then(|x| x.as_f64()).ok_or("The fold target must be a number.")?;
    if !(10.0..=2000.0).contains(&k) || k.fract() != 0.0 { return Err(format!("The fold target must be a whole number of k between 10 and 2000 (got {k}).")); }
    Ok(k as u64 * 1000)
}

// One lane's settings panel: fold target, global-or-own schedule, armed.
fn save_lane(h: &Hub, lane: Option<&str>, d: &serde_json::Value) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    let target = target_tokens(d.get("targetK"))?;
    let inherit = d.get("inherit").and_then(|x| x.as_bool()).unwrap_or(true);
    let own = if inherit { None } else { Some((hhmm(d.get("sleep"), "Sleep")?, hhmm(d.get("wake"), "Wake")?)) };
    cfg_set(h, &format!("lanes.{lane}.targetTokens"), &serde_json::json!(target))?;
    match own {
        None => { cfg_unset(h, &format!("lanes.{lane}.schedule"))?; }
        Some((sl, wk)) => { cfg_set(h, &format!("lanes.{lane}.schedule"), &serde_json::json!({"sleep": sl, "wake": wk}))?; }
    }
    if let Some(on) = d.get("armed").and_then(|x| x.as_bool()) { arm(h, &lane, on)?; }
    Ok(format!("Saved {lane}. The nightshift picks it up on its next check."))
}

// A hub's schedule panel: its schedule, then each of its lanes' rows.
fn save_settings(h: &Hub, d: &serde_json::Value) -> Result<String, String> {
    let sleep = hhmm(d.get("sleep"), "Sleep")?;
    let wake = hhmm(d.get("wake"), "Wake")?;
    let rows = d.get("lanes").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let mut checked = Vec::new();
    for r in &rows {
        let lane = h.check_lane(r.get("id").and_then(|x| x.as_str()))?;
        checked.push((lane, target_tokens(r.get("targetK"))?, r.get("armed").and_then(|x| x.as_bool())));
    }
    // No restart needed: the nightshift hot-reloads its config on mtime
    // (landed with --fold-now, bench scenario 15: a mid-evening schedule move
    // is honoured by the bell).
    cfg_set(h, "schedule.sleep", &serde_json::json!(sleep))?;
    cfg_set(h, "schedule.wake", &serde_json::json!(wake))?;
    for (lane, target, armed) in checked {
        cfg_set(h, &format!("lanes.{lane}.targetTokens"), &serde_json::json!(target))?;
        if let Some(on) = armed { arm(h, &lane, on)?; }
    }
    Ok(format!("Saved. The nightshift uses {sleep} → {wake} from its next check."))
}

// The deck's Nightly toggle: every lane of every hub armed, or none.
fn toggle_nightly(d: &serde_json::Value) -> Result<String, String> {
    let on = d.get("on").and_then(|x| x.as_bool()).ok_or("toggle-nightly needs on: true|false")?;
    for root in all_hub_roots() {
        let h = Hub::open(&root)?;
        for lane in h.lanes() { arm(&h, &lane, on)?; }
    }
    Ok(if on { "Nightly cycle on: every agent will be belled and woken.".into() } else { "Nightly cycle off: no agent will be belled or woken until you turn it back on.".into() })
}

// One lane's nightly switch: the bell slot on its card (Ra, 10/8). The same
// nightshift --arm/--disarm the settings save uses, for one lane.
fn arm_lane(h: &Hub, lane: Option<&str>, d: &serde_json::Value) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    let on = d.get("on").and_then(|x| x.as_bool()).ok_or("arm-lane needs on: true|false")?;
    arm(h, &lane, on)?;
    Ok(if on { format!("{lane} armed: belled at their sleep time and woken at their wake time.") } else { format!("{lane} disarmed: no nightly bell or scheduled wake until they're armed again. A midday bell or Fold now still folds them.") })
}

// One lane's midday cycle switch, beside the bell (Ra, 10/12). On writes the
// ruled defaults (a soft bell at 85% of the window, an urgent one at 95% that
// forces after 10 minutes); off removes the setting, so the lane folds only at
// its nightly bell. The context watch reloads its config when the file
// changes, so neither needs a restart.
fn toggle_midday(h: &Hub, lane: Option<&str>, d: &serde_json::Value) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    let on = d.get("on").and_then(|x| x.as_bool()).ok_or("toggle-midday needs on: true|false")?;
    let key = format!("lanes.{lane}.middayCycle");
    if on {
        cfg_set(h, &key, &serde_json::json!({"softPct": 0.85, "urgentPct": 0.95, "urgentMin": 10}))?;
        Ok(format!("{lane}'s midday cycle is on: asked to fold at 85% of their window, and within ten minutes at 95%."))
    } else {
        cfg_unset(h, &key)?;
        Ok(format!("{lane}'s midday cycle is off: they fold only at their nightly bell."))
    }
}

// Stop managing a lane: disarm, then drop it from the config. Its
// transcripts, ladder and receipts stay on disk (the button's own promise).
fn remove_lane(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    arm(h, &lane, false)?;
    cfg_unset(h, &format!("lanes.{lane}"))?;
    // A lane-list change is structural: the nightshift reads it at boot.
    restart_daemon(h).map_err(|e| format!("Removed {lane}, but the nightshift didn't restart to drop them: {e}"))?;
    Ok(format!("Removed {lane} from Nightwatch. Their transcripts, ladder and receipts are still on disk."))
}

// Fold now (Ra's ruling): ring the real bell; the nightshift owns a 10-minute
// deadline, forces the fold if the lane hasn't folded by then, and either
// way closes the window and wakes a fresh one at once. The daemon's state
// file holds the request, so closing the app doesn't drop it.
fn emergency_fold(h: &Hub, lane: Option<&str>) -> Result<String, String> {
    let lane = h.check_lane(lane)?;
    h.node("nightshift.mjs", &["--fold-now", &lane])
        .map(|_| format!("Force-folding {lane}: their window closes, they fold, and a fresh one opens within a minute. The fresh window writes the rung."))
        .map_err(|e| e.replace("--fold-now: ", ""))
}

// The nightshift's own dry run: what it would do right now, touching nothing.
fn run_doctor(h: &Hub) -> Result<String, String> {
    h.node("nightshift.mjs", &["--preflight"])
}

#[cfg(test)]
mod creation_tests {
    use super::*;
    #[test]
    fn creation_is_offered_only_once_the_cli_exists() {
        let dir = std::env::temp_dir().join(format!("nw-creation-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!host_can(&dir).contains(&"plan"));
        std::fs::write(dir.join(NIGHTWATCH_CLI), "").unwrap();
        let can = host_can(&dir);
        for a in CREATION { assert!(can.contains(a), "{a}"); }
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn the_sweep_is_offered_only_once_the_cli_can_remove_one_item() {
        let dir = std::env::temp_dir().join(format!("nw-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(NIGHTWATCH_CLI), "doctor-sweep [--remove] [--yes]").unwrap();
        assert!(!host_can(&dir).contains(&"sweep"), "an older CLI has no per-item removal");
        std::fs::write(dir.join(NIGHTWATCH_CLI), "doctor-sweep --json | --remove-item <id>").unwrap();
        let can = host_can(&dir);
        for a in SWEEP { assert!(can.contains(a), "{a}"); }
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn hide_is_not_offered_where_nothing_can_bring_the_window_back() {
        let dir = std::env::temp_dir().join(format!("nw-hide-{}", std::process::id()));
        assert!(host_can_on(&dir, false).contains(&"hide-window"));
        let wsl = host_can_on(&dir, true);
        assert!(!wsl.contains(&"hide-window"), "WSLg has no tray to come back from");
        assert!(wsl.contains(&"wake"), "only hide is withheld");
    }
    #[test]
    fn a_removal_must_name_its_item() {
        let h = Hub { root: "/nowhere".into(), config_file: "/nowhere/x.json".into(), cfg: serde_json::Value::Null, machinery: "/nowhere".into(), state: "/nowhere".into() };
        for d in [serde_json::Value::Null, serde_json::json!({}), serde_json::json!({ "id": "  " }), serde_json::json!({ "id": 7 })] {
            assert!(remove_orphan(&h, &d).unwrap_err().contains("nothing was done"), "{d}");
        }
    }
    #[test]
    fn an_empty_spec_never_reaches_the_cli() {
        let h = Hub { root: "/nowhere".into(), config_file: "/nowhere/x.json".into(), cfg: serde_json::Value::Null, machinery: "/nowhere".into(), state: "/nowhere".into() };
        assert!(with_spec(&h, "apply", &serde_json::Value::Null).is_err());
        assert!(inspect_import(&h, &serde_json::json!({ "from": "  " })).is_err());
    }
    #[test]
    fn set_up_runs_live_and_adding_an_agent_does_not() {
        // Without --live, init stages the hub and installs nothing (b939c71),
        // so a Set up that dropped the flag would make an agent who never wakes.
        let init = serde_json::json!({"op": "init"});
        assert_eq!(creation_args("plan", &init, "/s.json"), vec!["plan", "/s.json", "--live"]);
        assert_eq!(creation_args("apply", &init, "/s.json"), vec!["apply", "/s.json", "--live"]);
        assert_eq!(creation_args("apply", &serde_json::json!({"op": "lane-add"}), "/s.json"), vec!["apply", "/s.json"]);
    }
}

#[cfg(test)]
mod batch3_tests {
    use super::*;
    #[test]
    fn times_and_targets_are_validated() {
        assert_eq!(hhmm(Some(&serde_json::json!("02:00")), "Sleep").unwrap(), "02:00");
        for bad in ["2:00", "24:00", "12:60", "ab:cd", "", "02:00 "] { assert!(hhmm(Some(&serde_json::json!(bad)), "Sleep").is_err(), "{bad}"); }
        assert_eq!(target_tokens(Some(&serde_json::json!(250))).unwrap(), 250_000);
        for bad in [serde_json::json!(5), serde_json::json!(2500), serde_json::json!(250.5), serde_json::json!("250")] { assert!(target_tokens(Some(&bad)).is_err()); }
    }
}

#[cfg(test)]
mod hub_tests {
    use super::*;
    // A scratch hub that removes itself when the test ends, pass or panic
    // (10/16: every run had left its four nw-hub-* dirs in the temp dir).
    struct Scratch(PathBuf);
    impl std::ops::Deref for Scratch { type Target = PathBuf; fn deref(&self) -> &PathBuf { &self.0 } }
    impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn scratch(name: &str) -> Scratch {
        let d = std::env::temp_dir().join(format!("nw-hub-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Scratch(d)
    }
    #[test]
    fn a_hub_reads_its_own_config_machinery_and_state() {
        let new = scratch("new");
        std::fs::write(new.join("nightwatch.config.json"), r#"{"persona":{"name":"Lark"},"lanes":{"main":{}},"paths":{"machinery":"/app/machinery"}}"#).unwrap();
        std::fs::create_dir_all(new.join("wakecycle")).unwrap();
        std::fs::write(new.join("wakecycle/house.nightwatch.lark.plist"), "").unwrap();
        let h = Hub::open(&new).unwrap();
        assert_eq!(h.machinery, PathBuf::from("/app/machinery"));
        assert_eq!(h.state, new.join("wakecycle"));
        assert_eq!(h.name(), "Lark");
        assert_eq!(h.daemon_label().as_deref(), Some("house.nightwatch.lark"));
        assert!(h.check_lane(Some("main")).is_ok());
        assert!(h.check_lane(Some("fable")).is_err());
        // our legacy hub: weft.config.json, its own wakecycle/ for both, the old job
        let old = scratch("old");
        std::fs::write(old.join("weft.config.json"), r#"{"lanes":{"fable":{}}}"#).unwrap();
        let h = Hub::open(&old).unwrap();
        assert_eq!((h.machinery.clone(), h.state.clone()), (old.join("wakecycle"), old.join("wakecycle")));
        let no_units = scratch("no-units");
        let want = if cfg!(target_os = "macos") { Some("com.weft.nightshift") } else { None };
        assert_eq!(h.daemon_label_in(&no_units).as_deref(), want);
    }
    // Off macOS only: there the legacy launchd label answers before any unit
    // is read (Weft's review on the Mac, 10/20).
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_hand_set_up_hub_finds_its_installed_unit() {
        // No state-dir copy (set up by hand, as on WSL 10/16): the installed
        // nightshift unit that names this hub's config, never its .watch twin
        // or another hub's. Shapes as daemonJob writes them, plus a hand-made
        // unit that still says WEFT_CONFIG.
        let hub = scratch("by-hand");
        std::fs::write(hub.join("nightwatch.config.json"), r#"{"lanes":{"main":{}}}"#).unwrap();
        std::fs::create_dir_all(hub.join("wakecycle")).unwrap();
        let h = Hub::open(&hub).unwrap();
        let cfg = h.config_file.display().to_string();
        let unit = |script: &str, key: &str, cfg: &str| format!("[Service]\nExecStart=\"/usr/bin/node\" \"/nw/machinery/{script}\"\nEnvironment=\"{key}={cfg}\"\nRestart=always\n");
        let units = scratch("units");
        std::fs::write(units.join("house.nightwatch.other.service"), unit("nightshift.mjs", "NIGHTWATCH_CONFIG", "/elsewhere/nightwatch.config.json")).unwrap();
        std::fs::write(units.join("house.nightwatch.mine.watch.service"), unit("watch.mjs", "NIGHTWATCH_CONFIG", &cfg)).unwrap();
        assert_eq!(h.daemon_label_in(&units), None, "a .watch unit or another hub's must not be taken for this hub's nightshift");
        std::fs::write(units.join("house.nightwatch.mine.service"), unit("nightshift.mjs", "WEFT_CONFIG", &cfg)).unwrap();
        assert_eq!(h.daemon_label_in(&units).as_deref(), Some("house.nightwatch.mine"));
        std::fs::write(units.join("house.nightwatch.mine.service"), unit("nightshift.mjs", "NIGHTWATCH_CONFIG", &cfg)).unwrap();
        assert_eq!(h.daemon_label_in(&units).as_deref(), Some("house.nightwatch.mine"));
        // A staged copy still wins, as before.
        std::fs::write(hub.join("wakecycle/house.nightwatch.staged.service"), "").unwrap();
        assert_eq!(h.daemon_label_in(&units).as_deref(), Some("house.nightwatch.staged"));
    }
    #[test]
    fn a_unit_names_its_config_with_percent_doubled() {
        // daemonJob doubles % for systemd.
        let body = "[Service]\nExecStart=\"/usr/bin/node\" \"/nw/machinery/nightshift.mjs\"\nEnvironment=\"NIGHTWATCH_CONFIG=/h/100%%/nightwatch.config.json\"\n";
        let pct = [("house.nightwatch.p.service".to_string(), body.to_string())];
        assert_eq!(unit_for_config(&pct, Path::new("/h/100%/nightwatch.config.json")).as_deref(), Some("house.nightwatch.p"));
    }
    #[test]
    fn only_a_registered_hub_can_be_named() {
        let a = scratch("reg-a");
        std::fs::write(a.join("nightwatch.config.json"), r#"{"lanes":{"main":{}}}"#).unwrap();
        let stranger = scratch("stranger");
        std::fs::write(stranger.join("nightwatch.config.json"), r#"{"lanes":{"main":{}}}"#).unwrap();
        let roots = vec![a.clone()];
        assert_eq!(canon(&hub_among(Some(&a.to_string_lossy()), roots.clone()).unwrap().root), canon(&a));
        assert!(hub_among(Some(&stranger.to_string_lossy()), roots.clone()).is_err());
        assert_eq!(canon(&hub_among(None, roots).unwrap().root), canon(&a)); // no hub named: the first
    }
    #[test]
    fn paths_bound_for_a_command_line_are_plain() {
        assert!(plain_path(Path::new("/Users/x/Nightwatch/lark/nightwatch.config.json")).is_ok());
        for bad in ["/a\"b", "/a$b", "/a`b", "/a\\b"] { assert!(plain_path(Path::new(bad)).is_err(), "{bad}"); }
    }
}

// ---------------------------------------------------------------- lane creation
// Set up / Add agent / Import (10/6). The page builds one spec; the house's
// own CLI (Fable's machinery/nightwatch.mjs) dry-runs it (plan) and builds it
// (apply), so the preview the person confirms is exactly what gets done. The
// app only passes things through: the CLI validates and owns every write.
// A lane-add runs in the persona it was opened from (their hub's config); Set
// up makes a new hub, named in the spec, with the app's own machinery.
const CREATION: &[&str] = &["plan", "apply", "inspect-import", "list-unclaimed"];
const NIGHTWATCH_CLI: &str = "nightwatch.mjs";

// Offered only once the CLI exists, so until then Set up and Preview stay
// read-only instead of failing on press.
fn creation_ready(machinery: &std::path::Path) -> bool { machinery.join(NIGHTWATCH_CLI).is_file() }

fn with_spec(h: &Hub, op: &str, d: &serde_json::Value) -> Result<String, String> {
    if !d.is_object() { return Err("The app sent an empty spec; nothing was done.".into()); }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_nanos()).unwrap_or(0);
    let path = std::env::temp_dir().join(format!("nightwatch-spec-{}-{nanos}.json", std::process::id()));
    std::fs::write(&path, d.to_string()).map_err(|e| format!("couldn't write the spec: {e}"))?;
    let p = path.to_string_lossy().to_string();
    let args = creation_args(op, d, &p);
    let out = h.node(NIGHTWATCH_CLI, &args.iter().map(String::as_str).collect::<Vec<_>>());
    let _ = std::fs::remove_file(&path);
    out
}

// Set up (op "init") runs with --live, for its preview and its build alike.
// Since refuse-by-default (b939c71), init writes nothing outside the hub
// without it: no background jobs, no registry entry, no first session. The
// person's Confirm, after a preview that names each of those writes, is the
// deliberate act --live stands for (Fable and opus, 10/16). The machinery
// still refuses a hub in scratch space, flag or no flag. Adding an agent
// doesn't read the flag, so it gets none.
fn creation_args(op: &str, d: &serde_json::Value, spec_path: &str) -> Vec<String> {
    let mut a = vec![op.to_string(), spec_path.to_string()];
    if d.get("op").and_then(|x| x.as_str()) == Some("init") { a.push("--live".into()); }
    a
}

fn inspect_import(h: &Hub, d: &serde_json::Value) -> Result<String, String> {
    let from = d.get("from").and_then(|x| x.as_str()).filter(|x| !x.trim().is_empty()).ok_or("Type the folder to import.")?;
    h.node(NIGHTWATCH_CLI, &["inspect-import", from])
}

// The hub that runs a creation step: Set up (op "init") runs the app's own
// machinery; everything else runs in the hub the action names.
// The orphan sweep (doctor-sweep): launchd jobs and registry entries whose
// hub or machinery is gone. It is user-global, not one hub's, so it runs the
// app's own machinery, the same file host_can probed. The page reads the
// findings as data and asks before each removal; the CLI re-sweeps and
// removes exactly the one item named, and refuses anything no longer an
// orphan or never removable (a job it couldn't read).
const SWEEP: &[&str] = &["sweep", "remove-orphan"];
fn sweep_ready(machinery: &std::path::Path) -> bool {
    std::fs::read_to_string(machinery.join(NIGHTWATCH_CLI)).map(|s| s.contains("--remove-item")).unwrap_or(false)
}
fn sweep_hub(sel: Option<&str>) -> Result<Hub, String> {
    let mut h = hub(sel)?;
    h.machinery = app_machinery();
    Ok(h)
}
fn remove_orphan(h: &Hub, d: &serde_json::Value) -> Result<String, String> {
    let id = d.get("id").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
        .ok_or("The app didn't name which leftover to remove; nothing was done.")?;
    h.node(NIGHTWATCH_CLI, &["doctor-sweep", "--remove-item", id])
}

fn creation_hub(sel: Option<&str>, d: &serde_json::Value) -> Result<Hub, String> {
    let init = d.get("op").and_then(|v| v.as_str()) == Some("init");
    let mut h = match hub(sel) {
        Ok(h) => h,
        // The first Set up on a machine with no hub yet has no hub to borrow:
        // it runs against the new hub's own config, not written yet.
        Err(e) if first_setup_allowed(init, sel, all_hub_roots().is_empty()) => first_hub(d).ok_or(e)?,
        Err(e) => return Err(e),
    };
    if init { h.machinery = app_machinery(); }
    Ok(h)
}

// Only a Set up (init), naming no hub, on a machine whose registry lists
// none: adding an agent, or anything aimed at a named hub, keeps the error.
fn first_setup_allowed(init: bool, sel: Option<&str>, no_hubs: bool) -> bool { init && sel.is_none() && no_hubs }

// The hub a first Set up is creating, as the CLI needs it: its config path
// (which init writes) and a working folder that already exists, the nearest
// existing folder above it (init assembles the hub beside its path and moves
// it into place). The spec's folder must be absolute, or ~/ for home.
fn first_hub(d: &serde_json::Value) -> Option<Hub> {
    let raw = d.get("hub").and_then(|v| v.as_str())?.trim();
    let target = match raw.strip_prefix("~/") { Some(rest) => home().join(rest), None if raw.starts_with('/') => PathBuf::from(raw), None => return None };
    let root = target.ancestors().skip(1).find(|p| p.is_dir()).map(Path::to_path_buf).unwrap_or_else(home);
    Some(Hub { root, config_file: target.join("nightwatch.config.json"), cfg: serde_json::json!({}), machinery: app_machinery(), state: target.join("wakecycle") })
}

#[tauri::command]
fn act(app: AppHandle, action: String, lane: Option<String>, hub: Option<String>, data: Option<serde_json::Value>) -> Result<String, String> {
    let d = data.unwrap_or(serde_json::Value::Null);
    log::info!("act {action} lane={lane:?} hub={hub:?}");
    let sel = hub.as_deref();
    let h = || self::hub(sel);
    let lane = lane.as_deref();
    match action.as_str() {
        // The page pings once at load: proof the bridge is permitted.
        "ping" => Ok("pong".into()),
        "hide-window" => {
            if on_wsl() { return Err("Hide has no way back on WSL (there's no tray icon); click Nightwatch's taskbar icon to minimize it instead.".into()); }
            if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
            Ok(String::new())
        }
        "wake" | "retry-wake" => wake(&h()?, lane),
        "sleep" => sleep(&h()?, lane),
        "open-terminal" => lane_terminal(&h()?, lane, "show"),
        "hide-terminal" => lane_terminal(&h()?, lane, "hide"),
        "terminal-state" => lane_terminal(&h()?, lane, "state"),
        "wake-all" => for_all(wake, "already awake").map(|m| format!("Woke: {m}")),
        "sleep-all" => for_all(sleep, "not awake").map(|m| format!("Rang the bell for: {m}")),
        "restore-checkpoint" => restore_checkpoint(&h()?),
        "restart-daemon" => restart_daemon(&h()?),
        "save-lane" => save_lane(&h()?, lane, &d),
        "save-settings" => save_settings(&h()?, &d),
        "toggle-nightly" => toggle_nightly(&d),
        "arm-lane" => arm_lane(&h()?, lane, &d),
        "toggle-midday" => toggle_midday(&h()?, lane, &d),
        "remove-lane" => remove_lane(&h()?, lane),
        "emergency-fold" => emergency_fold(&h()?, lane),
        "fold-all" => for_all(emergency_fold, "not awake").map(|m| format!("Force-folding: {m}")),
        "run-doctor" => run_doctor(&h()?),
        "plan" => with_spec(&creation_hub(sel, &d)?, "plan", &d),
        "apply" => with_spec(&creation_hub(sel, &d)?, "apply", &d),
        "inspect-import" => inspect_import(&h()?, &d),
        "list-unclaimed" => h()?.node(NIGHTWATCH_CLI, &["list-unclaimed"]),
        "sweep" => sweep_hub(sel)?.node(NIGHTWATCH_CLI, &["doctor-sweep", "--json"]),
        "remove-orphan" => remove_orphan(&sweep_hub(sel)?, &d),
        other => Err(format!("{other} isn't wired in the app yet")),
    }
}

// Tells the page it's inside the app (runtime.js then leaves the window
// transparent) and gives it the host bridge. can() names what's wired, so
// every other write button keeps its read-only state.
fn init_script() -> String {
    format!(r#"window.NW_SHELL = 'tauri';
window.NW_HOST = {{
  can: (a) => {can}.includes(a),
  act: (action, o = {{}}) => window.__TAURI_INTERNALS__.invoke('act', {{ action, lane: o.lane ?? null, hub: o.hub ?? null, data: o.data ?? null }}),
  hitRects: (rects) => window.__TAURI_INTERNALS__.invoke('set_hit_rects', {{ rects }}),
  onTop: (on) => window.__TAURI_INTERNALS__.invoke('set_on_top', {{ on }}),
}};
addEventListener('DOMContentLoaded', () => window.NW_HOST.act('ping').catch((e) => console.error('nightwatch bridge:', e)));"#, can = serde_json::to_string(&host_can(&app_machinery())).unwrap())
}

fn host_can(machinery: &std::path::Path) -> Vec<&'static str> { host_can_on(machinery, on_wsl()) }
fn host_can_on(machinery: &std::path::Path, wsl: bool) -> Vec<&'static str> {
    let mut v = HOST_CAN.to_vec();
    // WSLg shows no tray icon, so a hidden window had no way back: only killing
    // the app returned it (Terra, 10/20). Hide comes back with a second launch
    // that shows the first window (single-instance), not before.
    if wsl { v.retain(|a| *a != "hide-window"); }
    if creation_ready(machinery) { v.extend_from_slice(CREATION); }
    if sweep_ready(machinery) { v.extend_from_slice(SWEEP); }
    v
}
// WSL_DISTRO_NAME isn't in every process's environment (a systemd user
// service on WSL doesn't carry it, 10/20), so the kernel's release string
// counts too: WSL's kernels are built as "...-microsoft-standard-WSL2".
fn on_wsl() -> bool {
    is_wsl(std::env::var_os("WSL_DISTRO_NAME"), std::fs::read_to_string("/proc/sys/kernel/osrelease").ok().as_deref())
}
fn is_wsl(distro: Option<std::ffi::OsString>, osrelease: Option<&str>) -> bool {
    distro.is_some_and(|d| !d.is_empty()) || osrelease.is_some_and(|r| r.to_ascii_lowercase().contains("microsoft"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_canvas_is_set_once_per_work_area() {
        // Compared with what was asked for, so a window manager's frame
        // extents in the readback can't make every tick re-set it.
        let wa = [0.0, 0.0, 2560.0, 1440.0];
        assert!(!already_covered(None, wa), "the first cover always sets the canvas");
        assert!(already_covered(Some(wa), wa));
        assert!(already_covered(Some([0.0, 0.0, 2560.4, 1440.0]), wa), "sub-pixel rounding isn't a change");
        assert!(!already_covered(Some(wa), [2560.0, 0.0, 1920.0, 1080.0]), "another display is followed");
        assert!(!already_covered(Some(wa), [0.0, 0.0, 2560.0, 1392.0]), "a taskbar or resolution change is followed");
    }
    #[test]
    fn x11_on_wsl_unless_a_backend_was_chosen() {
        let os = |s: &str| Some(std::ffi::OsString::from(s));
        assert!(wsl_wants_x11(true, None));
        assert!(!wsl_wants_x11(true, os("wayland")), "a chosen backend is never overridden");
        assert!(!wsl_wants_x11(false, None), "plain Linux keeps GTK's own choice");
        // WSL is known by its distro variable or by its kernel.
        assert!(is_wsl(os("Ubuntu-26.04"), None));
        assert!(is_wsl(None, Some("6.18.54.1-microsoft-standard-WSL2\n")), "a process started without WSL's environment");
        assert!(!is_wsl(os(""), Some("6.8.0-45-generic\n")));
        assert!(!is_wsl(None, None));
    }
    #[test]
    fn lanes_must_be_known_and_plain() {
        let h = Hub { root: "/h".into(), config_file: "/h/c.json".into(), cfg: serde_json::json!({"lanes": {"fable": {}, "opus": {}}}), machinery: "/h".into(), state: "/h".into() };
        assert_eq!(h.check_lane(Some("opus")).unwrap(), "opus");
        assert!(h.check_lane(Some("scout")).is_err());
        assert!(h.check_lane(Some("opus\" & quit")).is_err());
        assert!(h.check_lane(Some("")).is_err());
        assert!(h.check_lane(None).is_err());
    }
    #[test]
    fn only_timestamped_archives_restore() {
        assert!(is_archive_name("2026-10-06-0204.md"));
        assert!(!is_archive_name("decoy-wakecycle-copy-2026-10-05.md"));
        assert!(!is_archive_name("stray-root-copy-removed-2026-10-05.md"));
        assert!(!is_archive_name("2026-10-06-0204.md.bak"));
        assert!(!is_archive_name("2026-10-06-02a4.md"));
    }
    #[test]
    fn pointer_over_modules_only() {
        let r = vec![[0.0, 0.0, 100.0, 40.0], [0.0, 40.0, 60.0, 50.0]]; // an L: head, then a narrower card
        assert!(over_module(&r, 50.0, 20.0));
        assert!(over_module(&r, 30.0, 70.0));
        assert!(!over_module(&r, 90.0, 70.0)); // the empty corner
        assert!(!over_module(&[], 10.0, 10.0));
    }
    #[test]
    fn refuses_a_lane_that_is_already_resumed() {
        let ps = "COMMAND\nclaude --resume 3e865d2d-x --fork-session\n/bin/zsh\n";
        let s = vec!["b438479a-y".to_string(), "3e865d2d-x".to_string()];
        assert_eq!(live_resume(ps, &s).as_deref(), Some("3e865d2d-x"));
        assert_eq!(live_resume("claude --resume other\n", &s), None);
        // a grep or an editor naming the sid isn't a live session
        assert_eq!(live_resume("grep --resume 3e865d2d-x\n", &s), None);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before GTK starts and before any thread exists (main calls this first),
    // which is what makes set_var sound here.
    #[cfg(target_os = "linux")]
    if wsl_wants_x11(on_wsl(), std::env::var_os("GDK_BACKEND")) {
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
    tauri::Builder::default()
        // One Nightwatch at a time: a second launch (the dock, a launcher, the
        // command line) brings the first one's window back instead of starting
        // another copy. It goes first, as the plugin asks, so a second copy
        // exits before it builds anything. Linux finds the first copy over the
        // D-Bus session bus, and without one launches normally (the plugin's
        // own fallback).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("second launch: showing this window");
            show_main(app);
        }))
        .setup(|app| {
            // Logged in every build (~/Library/Logs/house.weft.nightwatch/): the installed app is a release
            // build, and a problem only the real window shows needs its own receipts (10/6, the menu cutoff).
            app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            log::info!("nightwatch starting; repo {}, hubs {:?}", repo().display(), all_hub_roots());
            // A menu-bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let url = match ensure_server() {
                Ok(()) => format!("http://127.0.0.1:{}/", port()),
                Err(e) => {
                    log::error!("{e}");
                    format!("data:text/html,<body style='font:14px system-ui;padding:24px;background:%23111;color:%23ddd'>Nightwatch couldn't start its viewer: {}</body>", e.replace('#', "%23"))
                }
            };
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Nightwatch")
                .inner_size(1100.0, 760.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(false) // the page applies the viewer's stored choice
                .initialization_script(&init_script())
                .build()?;
            cover(&win);

            let show = MenuItem::with_id(app, "toggle", "Show or hide Nightwatch", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart Nightwatch", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Nightwatch", true, None::<&str>)?;
            TrayIconBuilder::with_id("nightwatch")
                // A template image: macOS recolours it for light and dark menu bars.
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Nightwatch")
                .menu(&Menu::with_items(app, &[&show, &restart, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "toggle" => toggle(app),
                    "restart" => restart_app(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;
            watch_pointer(app.handle().clone());
            Ok(())
        })
        // Closing the window hides it; the menu-bar icon brings it back.
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![act, set_hit_rects, set_on_top])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

// The rehearsal (10/7): the real action functions against a real scratch hub, through the real machinery CLIs.
// Opt-in, never in the default run: NW_REHEARSAL_HUB=<scratch hub> cargo test rehearsal -- --ignored --nocapture
// Spends nothing: no wake (that starts a session), no daemon restart of anything real.
#[cfg(test)]
mod rehearsal_tests {
    use super::*;
    #[test]
    #[ignore]
    fn rehearsal_on_a_scratch_hub() {
        let root = PathBuf::from(std::env::var("NW_REHEARSAL_HUB").expect("NW_REHEARSAL_HUB"));
        let h = hub_among(Some(&root.to_string_lossy()), vec![root.clone()]).expect("the scratch hub opens");
        println!("hub {} · {} · machinery {} · state {} · job {}", h.name(), h.config_file.display(), h.machinery.display(), h.state.display(), h.daemon_label().as_deref().unwrap_or("(none)"));
        let lane = h.lanes().first().cloned().expect("an agent");

        // the persona's settings panel, saved through config.mjs set + nightshift --arm/--disarm
        let msg = save_settings(&h, &serde_json::json!({ "sleep": "03:10", "wake": "09:20", "lanes": [{ "id": lane, "targetK": 180, "armed": false }] })).expect("save-settings");
        println!("save-settings: {msg}");
        let after = Hub::open(&root).unwrap();
        assert_eq!(after.cfg["schedule"]["sleep"], "03:10");
        assert_eq!(after.cfg["schedule"]["wake"], "09:20");
        assert_eq!(after.cfg["lanes"][&lane]["targetTokens"], 180_000);
        let armed = std::fs::read_to_string(after.state.join("nightshift.armed")).unwrap_or_default();
        assert!(!armed.split(|c: char| c == ',' || c.is_whitespace()).any(|l| l == lane), "disarmed: {armed:?}");

        // the lane's own panel: back to armed, its own schedule
        let msg = save_lane(&after, Some(&lane), &serde_json::json!({ "targetK": 250, "inherit": false, "sleep": "02:30", "wake": "08:30", "armed": true })).expect("save-lane");
        println!("save-lane: {msg}");
        let after = Hub::open(&root).unwrap();
        assert_eq!(after.cfg["lanes"][&lane]["schedule"]["sleep"], "02:30");

        // the card's bell slot: one lane's nightly switch, off then on (10/8)
        let armed_has = |h: &Hub| std::fs::read_to_string(h.state.join("nightshift.armed")).unwrap_or_default()
            .split(|c: char| c == ',' || c.is_whitespace()).any(|l| l == lane);
        println!("arm-lane off: {}", arm_lane(&after, Some(&lane), &serde_json::json!({ "on": false })).expect("arm-lane off"));
        assert!(!armed_has(&after), "arm-lane off left the agent armed");
        println!("arm-lane on: {}", arm_lane(&after, Some(&lane), &serde_json::json!({ "on": true })).expect("arm-lane on"));
        assert!(armed_has(&after), "arm-lane on left the agent disarmed");
        assert!(arm_lane(&after, Some(&lane), &serde_json::json!({})).unwrap_err().contains("needs on"));
        // The midday switch (10/12): on writes the ruled defaults, off removes the key.
        println!("toggle-midday on: {}", toggle_midday(&after, Some(&lane), &serde_json::json!({ "on": true })).expect("toggle-midday on"));
        let on = Hub::open(&root).unwrap();
        assert_eq!(on.cfg["lanes"][&lane]["middayCycle"]["softPct"], 0.85);
        assert_eq!(on.cfg["lanes"][&lane]["middayCycle"]["urgentMin"], 10);
        println!("toggle-midday off: {}", toggle_midday(&on, Some(&lane), &serde_json::json!({ "on": false })).expect("toggle-midday off"));
        let off = Hub::open(&root).unwrap();
        assert!(off.cfg["lanes"][&lane].get("middayCycle").is_none(), "toggle-midday off left the setting");
        assert!(toggle_midday(&off, Some(&lane), &serde_json::json!({})).unwrap_err().contains("needs on"));

        // Check again: the hub's own nightshift dry run
        let pre = run_doctor(&after).expect("run-doctor");
        println!("run-doctor (first lines):\n{}", pre.lines().take(6).collect::<Vec<_>>().join("\n"));

        // Sleep: the hub's bell, rung by hand (a spool note; nothing launches)
        println!("sleep: {:?}", sleep(&after, Some(&lane)));

        // refusals in plain words: an unknown lane, a lane with no session to show, a hub not in the registry
        assert!(after.check_lane(Some("fable")).unwrap_err().contains("isn't one of"));
        println!("terminal-state: {:?}", lane_terminal(&after, Some(&lane), "state"));
        assert!(hub_among(Some("/tmp"), vec![root.clone()]).is_err());
    }
}

#[cfg(test)]
mod viewer_tests {
    use super::*;
    const REPO: &str = "/trees/ours";
    fn viewer(root: Option<&str>, started: Option<u64>) -> Answerer {
        Answerer::Viewer { pid: 41, root: root.map(PathBuf::from), rev: Some("688ed376f2a8".into()), started }
    }
    fn replaced(v: Verdict) -> bool { matches!(v, Verdict::Replace(41, _)) }
    fn refused_naming(v: Verdict, needles: &[&str]) -> bool {
        match v { Verdict::Refuse(m) => needles.iter().all(|n| m.contains(n)), _ => false }
    }

    #[test]
    fn our_trees_viewer_is_kept_until_its_code_changes() {
        let r = Path::new(REPO);
        assert_eq!(judge(&viewer(Some(REPO), Some(2000)), r, 1000, true, 7352), Verdict::Keep);
        assert_eq!(judge(&viewer(Some(REPO), Some(2000)), r, 2000, true, 7352), Verdict::Keep, "started the same ms");
        assert!(replaced(judge(&viewer(Some(REPO), Some(2000)), r, 3000, true, 7352)), "a pull after it started");
        assert!(replaced(judge(&viewer(Some(REPO), None), r, 0, true, 7352)), "from before /whoami");
    }

    // The removed worktree (WSL, 10/21) is replaced; another living tree's
    // viewer never is (two hubs on one port would kill each other's, Weft).
    #[test]
    fn a_gone_tree_is_replaced_and_a_living_one_is_refused() {
        let r = Path::new(REPO);
        assert!(replaced(judge(&viewer(Some("/trees/removed"), Some(9)), r, 5, false, 7352)));
        assert!(replaced(judge(&viewer(Some("/trees/removed"), None), r, 5, false, 7352)));
        assert!(refused_naming(judge(&viewer(Some("/trees/theirs"), Some(9)), r, 5, true, 7352), &["/trees/theirs", REPO, "pid 41", "7352"]));
        assert!(refused_naming(judge(&viewer(None, None), r, 5, true, 7352), &["pid 41"]), "a viewer whose tree can't be told");
    }

    #[test]
    fn a_stranger_on_the_port_is_never_killed() {
        let a = Answerer::Other { pid: Some(77), cmd: "python3 -m http.server 7352".into() };
        assert!(refused_naming(judge(&a, Path::new(REPO), 0, false, 7352), &["isn't a Nightwatch viewer", "http.server"]));
        assert!(refused_naming(judge(&Answerer::Other { pid: None, cmd: String::new() }, Path::new(REPO), 0, false, 7352), &["command unknown"]));
    }

    #[test]
    fn a_viewer_is_known_by_its_command_line() {
        assert_eq!(viewer_root_in("/usr/bin/node /home/t/nw/gui/server.mjs"), Some(Some(PathBuf::from("/home/t/nw"))));
        assert_eq!(viewer_root_in("node server.mjs"), Some(None), "started by hand inside gui/: a viewer, tree unknown");
        assert_eq!(viewer_root_in("/usr/bin/node /srv/app/server.mjs"), None, "some other server.mjs");
        assert_eq!(viewer_root_in("/usr/bin/python3 /home/t/nw/gui/server.mjs"), None);
        assert_eq!(viewer_root_in(""), None);
    }

    // End to end on a spare port, with fake viewers in scratch trees: real
    // processes, the real /whoami and command-line checks, the real kill.
    const FAKE: &str = r#"import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const started = Date.now();
const legacy = process.env.FAKE_LEGACY === '1';
createServer((q, r) => {
  if (q.url === '/whoami' && !legacy) { r.end(JSON.stringify({ nightwatch: 'viewer', root, rev: null, started, pid: process.pid })); return; }
  r.writeHead(404); r.end();
}).listen(Number(process.env.NIGHTWATCH_PORT), '127.0.0.1');
"#;
    fn fake_tree(t: &Path, name: &str) -> PathBuf {
        let tree = t.join(name);
        std::fs::create_dir_all(tree.join("gui")).unwrap();
        std::fs::create_dir_all(tree.join("machinery")).unwrap();
        std::fs::write(tree.join("gui/server.mjs"), FAKE).unwrap();
        std::fs::write(tree.join("machinery/nightshift.mjs"), "").unwrap();
        canon(&tree)
    }
    fn spare_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() }
    fn start(node: &Path, script: &Path, port: u16, legacy: bool) -> std::process::Child {
        let mut c = Command::new(node);
        c.arg(script).env("NIGHTWATCH_PORT", port.to_string()).stdout(Stdio::null()).stderr(Stdio::null());
        if legacy { c.env("FAKE_LEGACY", "1"); }
        let child = c.spawn().unwrap();
        let t = Instant::now();
        while !server_up_at(port) && t.elapsed() < Duration::from_secs(10) { std::thread::sleep(Duration::from_millis(50)); }
        child
    }
    fn whoami_root(port: u16) -> Option<String> {
        let (_, body) = http_get(port, "/whoami")?;
        serde_json::from_str::<serde_json::Value>(&body).ok()?.get("root")?.as_str().map(String::from)
    }
    // The fakes are this test's children, so a stopped one lingers as a zombie
    // until reaped: ask the child, not kill -0.
    fn running(c: &mut std::process::Child) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(2) {
            if c.try_wait().unwrap().is_some() { return false; }
            std::thread::sleep(Duration::from_millis(50));
        }
        true
    }
    fn touch_later(f: &Path) {
        std::fs::File::options().write(true).open(f).unwrap()
            .set_modified(std::time::SystemTime::now() + Duration::from_secs(5)).unwrap();
    }
    fn reap(mut c: std::process::Child) { let _ = c.kill(); let _ = c.wait(); }
    // The servers ensure_server_at starts aren't this test's children: stop
    // whatever still listens on the test's ports, even when an assert panics.
    struct Cleanup { ports: Vec<u16>, dir: PathBuf }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for p in &self.ports {
                if let Some(pid) = listener_pid(*p) { if viewer_root_in(&command_of(pid)).is_some() || command_of(pid).contains("stranger.mjs") { let _ = Command::new("/bin/kill").arg(pid.to_string()).status(); } }
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn end_to_end_replace_only_what_is_ours_and_stale() {
        let Some(node) = find_node() else { eprintln!("SKIP: no node"); return };
        let t = std::env::temp_dir().join(format!("nw-viewer-e2e-{}", std::process::id()));
        let ours = fake_tree(&t, "ours");
        let ours_s = ours.display().to_string();
        let ports: Vec<u16> = (0..5).map(|_| spare_port()).collect();
        let _cleanup = Cleanup { ports: ports.clone(), dir: t.clone() };

        // 1. Our own fresh viewer: kept, same process.
        let port = ports[0];
        let mut fresh = start(&node, &ours.join("gui/server.mjs"), port, false);
        assert_eq!(ensure_server_at(port, &ours), Ok(()));
        assert!(running(&mut fresh), "a fresh viewer of our tree is kept");
        // 2. The tree changes under it (a pull): replaced by a new one.
        touch_later(&ours.join("machinery/nightshift.mjs"));
        assert_eq!(ensure_server_at(port, &ours), Ok(()));
        assert!(!running(&mut fresh), "the stale viewer was stopped");
        assert_eq!(whoami_root(port).as_deref(), Some(ours_s.as_str()));
        reap(fresh);

        // 3. A viewer from a tree since removed (the 10/21 case): replaced.
        let port = ports[1];
        let gone = fake_tree(&t, "gone");
        let mut stale = start(&node, &gone.join("gui/server.mjs"), port, false);
        std::fs::remove_dir_all(&gone).unwrap();
        assert_eq!(ensure_server_at(port, &ours), Ok(()));
        assert!(!running(&mut stale), "the gone tree's viewer was stopped");
        assert_eq!(whoami_root(port).as_deref(), Some(ours_s.as_str()));
        reap(stale);

        // 4. Another living tree's viewer: refused by name, left running.
        let port = ports[2];
        let theirs = fake_tree(&t, "theirs");
        let mut other = start(&node, &theirs.join("gui/server.mjs"), port, false);
        let e = ensure_server_at(port, &ours).unwrap_err();
        assert!(e.contains(&theirs.display().to_string()) && e.contains(&ours_s), "{e}");
        assert!(running(&mut other), "another hub's viewer is never killed");
        reap(other);

        // 5. A viewer from before /whoami in our tree: found by its port and
        // command line, replaced.
        let port = ports[3];
        let mut legacy = start(&node, &ours.join("gui/server.mjs"), port, true);
        assert_eq!(ensure_server_at(port, &ours), Ok(()));
        assert!(!running(&mut legacy), "the legacy viewer was stopped");
        assert_eq!(whoami_root(port).as_deref(), Some(ours_s.as_str()), "the new one answers /whoami");
        reap(legacy);

        // 6. A stranger on the port: refused, left running.
        let port = ports[4];
        let stranger = t.join("stranger.mjs");
        std::fs::write(&stranger, FAKE.replace("const legacy = process.env.FAKE_LEGACY === '1';", "const legacy = true;").replace("realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))", "'/'")).unwrap();
        let mut s = start(&node, &stranger, port, true);
        let e = ensure_server_at(port, &ours).unwrap_err();
        assert!(e.contains("isn't a Nightwatch viewer"), "{e}");
        assert!(running(&mut s), "a stranger is never killed");
        reap(s);
    }
}
