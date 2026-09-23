# multi_instance_helper

A small native Windows helper for the "Allow multiple Roblox instances"
Danger Zone setting. Roblox enforces single-instance on Windows by creating
a named event object, `ROBLOX_singletonEvent`, when `RobloxPlayerBeta.exe`
starts, and refusing to open a second window if that object already exists.
That object is destroyed by the OS once nothing holds a handle to it, so
this helper finds and closes the handle the *already-running* client holds,
right before Toolblox launches another account's session. The next
instance then finds no existing singleton object and starts normally
instead of just activating the first window.

This is the same category of technique used by existing open-source Roblox
multi-instance tools (for example Bloxstrap's multi-instance launching).
The exact object name and type were confirmed here empirically, by
snapshotting a real `RobloxPlayerBeta.exe` process's open handle table
(some prior art describes a `ROBLOX_singletonMutex`; the live handle table
on the client versions tested during development showed an Event by this
name instead, not a Mutant, so `helper.c` matches on `ROBLOX_singletonEvent`).
If a future Roblox client version renames or restructures this, the fix is
a one-line change to `TARGET_OBJECT_SUBSTRING` in `helper.c`, not a redesign.

## How it works

1. Take the pids passed on the command line (decimal, space-separated) -
   `toolblox/roblox/multi_instance.py` passes only the RobloxPlayerBeta.exe
   pids it hasn't already cleared in an earlier call this run. A pid that
   isn't currently a real running `RobloxPlayerBeta.exe` process (stale,
   reused, or garbage) is silently dropped.
2. Ask the kernel for the full system-wide open-handle table
   (`NtQuerySystemInformation(SystemHandleInformation)`).
3. For each handle owned by one of those processes, duplicate it locally
   and ask its object name (`NtQueryObject(ObjectNameInformation)`), on a
   worker thread with a short timeout since this call can hang forever on
   certain handle types.
4. If the name contains `ROBLOX_singletonEvent`, close the *original*
   handle in the Roblox process itself (`DuplicateHandle` with
   `DUPLICATE_CLOSE_SOURCE`), which is what actually releases the object.

Each running instance only ever has its singleton handle closed **once**.
An earlier version had the helper self-discover and act on every running
`RobloxPlayerBeta.exe` process on every call, re-closing the handle of
instances that were already cleared by a previous join. See "Known
limitation" below for why that mattered.

`NtQuerySystemInformation` and `NtQueryObject` are undocumented NT
internals without a stable public header, so their prototypes and the
handle-table struct layout are declared directly in `helper.c`. That
layout has been stable for a long time and is the same one tools like
Sysinternals' Handle.exe and Process Hacker rely on.

This only ever touches handles already owned by `RobloxPlayerBeta.exe`
processes, and only ones whose name matches. It never needs administrator
privileges: `RobloxPlayerBeta.exe` runs as the same user, so
`OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION)`
against it succeeds without elevation.

The helper always exits 0. It's meant to run as a best-effort step right
before Toolblox launches a join; a failure here should never block the
join itself. If it can't find or close anything (including when no Roblox
process is running at all, which is the common case for the *first*
account's Join), it just does nothing.

## Known limitation

Reports: closing one open account's Roblox window (often the first one
opened) sometimes closes all the others too, and separately, an open
account occasionally just closes on its own with no user action. Roblox's
client appears to keep its own wait tied to `ROBLOX_singletonEvent` for
cross-instance signaling beyond the initial startup check, not just a
one-time check. Force-closing that handle out from under a still-running
process interrupts whatever that wait is for, and depending on how Roblox
handles that internally, may be what triggers the cascading/spontaneous
closes.

The "only touch each pid once" change above (never re-closing an
already-cleared instance's handle on a later join) is a mitigation aimed at
reducing how often we do that disruptive close against an already-running
instance - it should make the failure rarer, not eliminate it, since the
instance whose handle is closed is still disrupted at the moment it
happens. Bloxstrap, a much more mature project using this same category of
technique, has multiple open and unresolved GitHub issues with this exact
symptom (see e.g. bloxstraplabs/bloxstrap#5329, #5579, and
pizzaboxer/bloxstrap#1691), which points to the underlying fragility being
in Roblox's own client rather than something fixable purely from this
helper's side.

## What's verified vs. not

During development, this was verified against a real, locally running
`RobloxPlayerBeta.exe`: before running the helper, its
`ROBLOX_singletonEvent` handle was confirmed present in its handle table;
after running the helper, that handle was confirmed gone. That's the part
this helper is actually responsible for, and it works.

What was **not** verified end-to-end is a full two-account join (Roblox
requires a valid authentication ticket to reach the code path that would
create a second real game window, which needs a real, logged-in account
session). Confirm that separately, with two real saved accounts, once this
lands.

## Building

Requires the MSVC "Desktop development with C++" workload (or just the
standalone Build Tools). Run `build.ps1` from a plain PowerShell prompt —
it locates `vcvars64.bat` itself:

```powershell
.\native\multi_instance_helper\build.ps1
```

This produces `multi_instance_helper.exe` next to `helper.c`. Toolblox
loads it from that fixed path at runtime (see
`toolblox/roblox/multi_instance.py`); there's no install step for it yet,
which matches this project having no packaging/signing setup in general.
