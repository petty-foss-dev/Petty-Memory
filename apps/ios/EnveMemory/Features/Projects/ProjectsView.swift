import EnveMemoryKit
import SwiftUI

struct ProjectsView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var error: String?
    @State private var loaded = false
    @State private var cachedAt: Date?

    var body: some View {
        HearthScreen(title: "Projects") {
            if let cachedAt { CachedBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if store.projects.isEmpty, loaded, error == nil {
                EmptyStateView(symbol: "folder", title: "No projects yet",
                               message: "Create one on your computer with `petty-memory project new`, or let your AI do it.")
            }
            ForEach(store.projects) { project in
                Button { router.open(.project(project.id)) } label: { ProjectCard(project: project) }
                    .buttonStyle(.plain)
            }
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func load() async {
        do {
            cachedAt = try await store.load(connection)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

private struct ProjectCard: View {
    let project: Project
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                HStack(alignment: .firstTextBaseline) {
                    Text(project.name)
                        .font(HearthFont.sectionTitle)
                        .foregroundStyle(hearth.textPrimary)
                    Spacer()
                    if project.status != "active" {
                        Text(project.status.capitalized)
                            .font(HearthFont.caption.weight(.semibold))
                            .foregroundStyle(hearth.textSecondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(hearth.textTertiary)
                }
                if !project.description.isEmpty {
                    Text(project.description)
                        .font(HearthFont.callout)
                        .foregroundStyle(hearth.textSecondary)
                        .multilineTextAlignment(.leading)
                }
                Text("Updated \(project.updatedAt.formatted(.relative(presentation: .named)))")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}
