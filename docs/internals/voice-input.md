# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. The current implementation transcribes locally on supported iOS devices;
environment-backed transcription is not implemented.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Voice dispatch

CarPlay and Siri start threads instead of editing a draft, so a spoken or tapped
confirmation is the only path to sending. Transcription stays on device and uses the
same SpeechAnalyzer engine as dictation. A dispatched thread goes through the
[thread outbox](../../apps/mobile/src/features/voice-dispatch/startVoiceThread.ts) with
the payload an untouched new-task draft would send. That keeps it working against
existing servers and queues it while an environment is offline, except that a
worktree project needs its environment to choose the base branch. Choosing the project
on the server, with internal inference, would need a new contract and is not built.

JS runs the [CarPlay conversation](../../apps/mobile/src/features/voice-dispatch/voiceDispatchConversation.ts),
so it is testable and reloads with Fast Refresh. The
[native module](../../apps/mobile/modules/t3-voice-dispatch/ios) supplies speech,
listening, and CarPlay templates. It also keeps what must work before JS runs: the
project list Siri resolves names against, and requests waiting for JS.

CarPlay and Siri can launch the app without a phone window, and Expo starts React
Native only when the phone scene connects. The bridge therefore starts it into a
hidden window, and the template `SceneDelegate` adopts that root view controller when
the phone scene connects ([config plugin](../../apps/mobile/plugins/withVoiceDispatch.cjs)).
Never start a second root view: in Debug the dev launcher replaces the running JS
runtime, and in Release a second app tree mounts beside the first.

Connection credentials use expo-secure-store's `WhenUnlocked` default. A cold launch
from CarPlay or Siri while the iPhone is locked cannot read them, so it cannot connect
until the phone is unlocked once.

The CarPlay entitlement is opt-in (`T3CODE_IOS_CARPLAY=1`). Apple grants it per
team, and a device build fails to sign without it. The scene, intents, and handover are
in every build.
