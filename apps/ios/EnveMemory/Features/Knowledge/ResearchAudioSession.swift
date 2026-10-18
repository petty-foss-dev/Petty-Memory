import AVFoundation

actor ResearchAudioSession {
    static let shared = ResearchAudioSession()
    private var owner: UUID?

    func activate(_ owner: UUID, category: AVAudioSession.Category, mode: AVAudioSession.Mode = .default) throws {
        try Task.checkCancellation()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(category, mode: mode)
        try session.setActive(true)
        self.owner = owner
    }

    func deactivate(_ owner: UUID) {
        guard self.owner == owner else { return }
        self.owner = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
