import EnveMemoryKit
import Foundation
import Observation

/// The project list, mirrored into the App Group so the share sheet can offer it offline.
@Observable
final class ProjectStore {
    private(set) var projects: [Project] = []
    private let settings = SharedSettings()

    var refs: [ProjectRef] {
        projects.isEmpty ? settings.cachedProjects : projects.map(\.ref)
    }

    /// Drops the in-memory list after re-pairing; `refs` falls back to the (cleared) shared cache until the next load.
    func reset() {
        projects = []
    }

    /// Returns when the list shown was saved, if the server couldn't be reached.
    @discardableResult
    func load(_ connection: Connection) async throws -> Date? {
        guard connection.client != nil else { return nil }
        let loaded = try await connection.load(.projects, as: [Project].self)
        projects = loaded.value
        settings.cachedProjects = projects.map(\.ref)
        return loaded.cachedAt
    }

    func name(for id: String?) -> String? {
        guard let id else { return nil }
        return refs.first { $0.id == id }?.name
    }
}
