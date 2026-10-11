import CarPlay
import Foundation

/// A project the driver can send a voice note to, as JS last reported it.
public struct VoiceDispatchProjectSnapshot: Codable, Equatable, Sendable {
  public let key: String
  public let title: String
  public let subtitle: String?
  public let spokenNames: [String]
}

public enum VoiceDispatchStartStatus: String, Sendable {
  /// The server accepted the thread.
  case started
  /// The thread waits in the app's outbox until its environment reconnects.
  case queued
}

public enum VoiceDispatchError: LocalizedError {
  case appNotReady
  case timedOut
  case failed(String)

  public var errorDescription: String? {
    switch self {
    case .appNotReady:
      return "T3 Code didn't finish starting. Open it on your iPhone and try again."
    case .timedOut:
      return "T3 Code took too long to answer."
    case let .failed(message):
      return message
    }
  }
}

/// Code compiled into the app target, where React Native and App Intents
/// live. The bridge finds it by name so this pod needs neither.
@objc(T3VoiceDispatchAppSupporting)
public protocol T3VoiceDispatchAppSupporting: AnyObject {
  /// Starts React Native without a phone window, for CarPlay and Siri launches.
  @MainActor static func startReactRuntime()
  /// Siri phrases that name a project need refreshing when projects change.
  @MainActor static func projectsDidChange()
}

/// Shared state between the JS module, the CarPlay scene, and Siri intents.
/// JS owns the conversation and thread creation; native code only keeps what
/// must work before JS runs: the project list and the requests waiting for it.
@MainActor
public final class T3VoiceDispatchBridge {
  public static let shared = T3VoiceDispatchBridge()

  private static let projectsDefaultsKey = "t3.voiceDispatch.projects.v1"
  private static let readyTimeout: Duration = .seconds(20)
  private static let dispatchTimeout: Duration = .seconds(25)

  weak var module: T3VoiceDispatchModule?
  private(set) var carPlayScreen: CarPlayVoiceScreen?
  let speaker = VoiceSpeaker()
  private var listenerStorage: AnyObject?
  private var jsReady = false
  private var readyWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
  private var pendingDispatches: [String: CheckedContinuation<VoiceDispatchStartStatus, Error>] = [:]

  public private(set) var projects: [VoiceDispatchProjectSnapshot]

  private init() {
    if let data = UserDefaults.standard.data(forKey: Self.projectsDefaultsKey),
       let decoded = try? JSONDecoder().decode([VoiceDispatchProjectSnapshot].self, from: data) {
      projects = decoded
    } else {
      projects = []
    }
  }

  @available(iOS 26.0, *)
  var listener: VoiceListener {
    if let existing = listenerStorage as? VoiceListener {
      return existing
    }
    let created = VoiceListener()
    listenerStorage = created
    return created
  }

  private var appSupport: T3VoiceDispatchAppSupporting.Type? {
    NSClassFromString("T3VoiceDispatchAppSupport") as? T3VoiceDispatchAppSupporting.Type
  }

  // MARK: JS lifecycle

  func moduleWillUnload(_ module: T3VoiceDispatchModule) {
    guard self.module === module else { return }
    self.module = nil
    jsReady = false
    // A reload drops the JS side of every conversation and request. The old
    // prompt's buttons would reach no one, so show a neutral screen until
    // markReady announces the session again.
    stopVoice()
    carPlayScreen?.showStarting()
    failPendingDispatches(VoiceDispatchError.appNotReady)
  }

  /// JS subscribed to bridge events and can answer requests.
  func markReady(module: T3VoiceDispatchModule) {
    self.module = module
    jsReady = true
    for waiter in readyWaiters.values {
      waiter.resume(returning: true)
    }
    readyWaiters.removeAll()
    if carPlayScreen != nil {
      module.sendEvent(T3VoiceDispatchModule.carPlaySessionEvent, ["connected": true])
    }
  }

  func updateProjects(_ projects: [VoiceDispatchProjectSnapshot]) {
    guard projects != self.projects else { return }
    self.projects = projects
    if let data = try? JSONEncoder().encode(projects) {
      UserDefaults.standard.set(data, forKey: Self.projectsDefaultsKey)
    }
    appSupport?.projectsDidChange()
  }

  /// Starts React Native when needed and waits until JS can answer.
  func ensureReady() async -> Bool {
    if jsReady { return true }
    appSupport?.startReactRuntime()
    let id = UUID()
    return await withCheckedContinuation { continuation in
      readyWaiters[id] = continuation
      Task { @MainActor in
        try? await Task.sleep(for: Self.readyTimeout)
        if let waiter = self.readyWaiters.removeValue(forKey: id) {
          waiter.resume(returning: false)
        }
      }
    }
  }

  // MARK: Siri

  /// Asks JS to start a thread and waits for the outcome.
  public func dispatch(projectKey: String, text: String) async throws -> VoiceDispatchStartStatus {
    guard await ensureReady(), let module else { throw VoiceDispatchError.appNotReady }
    let requestId = UUID().uuidString
    return try await withCheckedThrowingContinuation { continuation in
      pendingDispatches[requestId] = continuation
      module.sendEvent(
        T3VoiceDispatchModule.dispatchRequestEvent,
        ["requestId": requestId, "projectKey": projectKey, "text": text]
      )
      Task { @MainActor in
        try? await Task.sleep(for: Self.dispatchTimeout)
        self.pendingDispatches.removeValue(forKey: requestId)?.resume(throwing: VoiceDispatchError.timedOut)
      }
    }
  }

  func resolveDispatch(requestId: String, status: String, message: String?) {
    guard let continuation = pendingDispatches.removeValue(forKey: requestId) else { return }
    if let started = VoiceDispatchStartStatus(rawValue: status) {
      continuation.resume(returning: started)
    } else {
      continuation.resume(throwing: VoiceDispatchError.failed(message ?? "Something went wrong."))
    }
  }

  private func failPendingDispatches(_ error: Error) {
    let pending = pendingDispatches
    pendingDispatches.removeAll()
    for continuation in pending.values {
      continuation.resume(throwing: error)
    }
  }

  // MARK: CarPlay

  func carPlayDidConnect(_ interfaceController: CPInterfaceController) {
    let screen = CarPlayVoiceScreen(interfaceController: interfaceController) { [weak self] buttonId in
      self?.module?.sendEvent(T3VoiceDispatchModule.buttonEvent, ["buttonId": buttonId])
    }
    carPlayScreen = screen
    screen.showStarting()
    if jsReady {
      module?.sendEvent(T3VoiceDispatchModule.carPlaySessionEvent, ["connected": true])
      return
    }
    // CarPlay can launch the app before its phone screen exists. markReady()
    // announces the session once JS is up.
    Task { @MainActor in
      if await !self.ensureReady(), self.carPlayScreen === screen {
        screen.showUnavailable()
      }
    }
  }

  func carPlayDidDisconnect() {
    stopVoice()
    carPlayScreen = nil
    VoiceAudioSession.deactivate()
    module?.sendEvent(T3VoiceDispatchModule.carPlaySessionEvent, ["connected": false])
  }

  /// Ends any prompt being read, listen in progress, and pending list choice.
  private func stopVoice() {
    carPlayScreen?.cancelPendingInteractions()
    speaker.stop()
    if #available(iOS 26.0, *) {
      (listenerStorage as? VoiceListener)?.cancel()
    }
  }
}
