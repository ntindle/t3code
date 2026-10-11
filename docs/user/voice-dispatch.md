# Start threads hands-free

On iPhone you can start a thread by voice, with Siri or from your car's CarPlay screen. Name a project,
say what you want built, and confirm. The thread starts with that project's defaults, the same as a
new task you send without changing any options.

## Siri

Say "Start a thread in T3 Code", or "Start a T3 Code thread in" followed by a project name. Siri asks
for anything you left out, reads your request back, and starts the thread when you confirm. It works
from the lock screen and in CarPlay without opening the app.

The same action is in the Shortcuts app and Spotlight, with a shortcut for each project.

## CarPlay

CarPlay shows T3 Code only in builds that Apple has approved for its voice app category.

Open T3 Code on the CarPlay screen and it asks which project to use. Say the project's name, or tap
**Projects** to pick it from a list. Then say what you want built. Tap **Done** to stop listening
early. When T3 Code reads your request back, say "yes" or tap **Start**.

## Things to know

- Speech is transcribed on your iPhone with Apple's on-device recognition, which needs iOS 26 or
  later. Only the text you confirm is sent. The first use may download Apple's speech model, which
  needs a network connection.
- Nothing starts without a confirmation. Silence or an unclear answer cancels.
- If the project's environment is offline, the thread is queued and starts when T3 Code reconnects.
  A project that starts threads in a worktree needs its environment reachable to choose the branch.
- iOS keeps T3 Code's saved connections locked while your iPhone is locked. If T3 Code isn't
  already running, unlock your iPhone once before using Siri or CarPlay.
