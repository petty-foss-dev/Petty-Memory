import EnveMemoryKit
import SwiftUI

/// Inline references in both directions, plus explicit connections that can be added and removed again.
struct ConnectionsSection: View {
    let item: Item
    let relations: [RelatedItem]
    let references: ReferenceList?

    @Environment(OutboxService.self) private var outbox
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var picking: Picking?
    @State private var pendingConnection: ItemPicker.Choice?
    @State private var removing: RelatedItem?

    private enum Picking: String, Identifiable {
        case reference, connection
        var id: String { rawValue }
    }

    private var actions: ItemActions { ItemActions(outbox: outbox, router: router) }
    private var editable: Bool { item.type != .decision && !item.isSecret }
    /// Supersession is the decision log's; it isn't removable here.
    private var connections: [RelatedItem] { relations.filter { $0.kind != "supersedes" } }

    var body: some View {
        if let references, !references.incoming.isEmpty {
            group("Backlinks", references.incoming, symbol: "arrow.uturn.left")
        }
        if let references, !references.outgoing.isEmpty {
            group("Links in this note", references.outgoing, symbol: "arrow.up.right")
        }
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            HStack {
                Overline("Connections")
                Spacer()
                if editable {
                    Menu {
                        Button("Insert a link in the text", systemImage: "link.badge.plus") { picking = .reference }
                        Button("Connect to an item", systemImage: "point.3.connected.trianglepath.dotted") { picking = .connection }
                    } label: {
                        Label("Add", systemImage: "plus").font(HearthFont.subheadline)
                    }
                    .accessibilityIdentifier("AddConnection")
                }
            }
            if connections.isEmpty {
                Text(editable ? "Nothing connected yet." : "Nothing connected.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            } else {
                RowStack(data: connections.map(ConnectionRow.init)) { row in
                    RelatedRow(relation: row.relation, symbol: row.relation.direction == "incoming" ? "arrow.down.left" : "arrow.up.right") {
                        router.open(.item(row.relation.id))
                    }
                    .contextMenu {
                        if editable {
                            Button("Remove connection", systemImage: "minus.circle", role: .destructive) { removing = row.relation }
                        }
                    }
                    .accessibilityAction(named: "Remove connection") {
                        if editable { removing = row.relation }
                    }
                }
            }
        }
        .sheet(item: $picking) { kind in
            ItemPicker(title: kind == .reference ? "Link to an item" : "Connect to an item", excluding: [item.id]) { choice in
                if kind == .reference {
                    Task {
                        await actions.edit(try? .insertReference(item.id, to: choice.id, label: choice.title),
                                           title: "Link “\(choice.title)”", sent: "Link added")
                    }
                } else {
                    pendingConnection = choice
                }
            }
            .environment(\.hearth, hearth)
        }
        .confirmationDialog("How is “\(pendingConnection?.title ?? "")” connected?",
                            isPresented: Binding(get: { pendingConnection != nil }, set: { if !$0 { pendingConnection = nil } }),
                            titleVisibility: .visible, presenting: pendingConnection) { choice in
            ForEach(RelationKind.editable, id: \.self) { kind in
                Button(kind.replacingOccurrences(of: "_", with: " ").capitalized) { connect(choice, kind: kind) }
            }
        }
        .confirmationDialog("Remove this connection?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { relation in
            Button("Remove", role: .destructive) { disconnect(relation) }
        } message: { relation in
            Text("Only the connection to “\(relation.title)” is removed. Both items stay, and you can connect them again.")
        }
    }

    private func group(_ title: String, _ related: [RelatedItem], symbol: String) -> some View {
        VStack(alignment: .leading, spacing: HearthSpacing.sm) {
            Overline(title)
            RowStack(data: related.map(ConnectionRow.init)) { row in
                RelatedRow(relation: row.relation, symbol: symbol) { router.open(.item(row.relation.id)) }
            }
        }
    }

    private func connect(_ choice: ItemPicker.Choice, kind: String) {
        pendingConnection = nil
        Task { await actions.edit(try? .relate(item.id, to: choice.id, kind: kind), title: "Connect “\(choice.title)”", sent: "Connected") }
    }

    private func disconnect(_ relation: RelatedItem) {
        removing = nil
        // A connection is stored from its source, so an incoming one is removed from the other side.
        let (from, to) = relation.direction == "incoming" ? (relation.id, item.id) : (item.id, relation.id)
        Task {
            await actions.edit(try? .unrelate(from, from: to, kind: relation.kind),
                               title: "Disconnect “\(relation.title)”", sent: "Connection removed")
        }
    }
}

private struct ConnectionRow: Identifiable {
    let relation: RelatedItem
    var id: String { "\(relation.kind)-\(relation.direction)-\(relation.id)" }
}

private struct RelatedRow: View {
    let relation: RelatedItem
    let symbol: String
    let open: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        Button(action: open) {
            HStack(spacing: HearthSpacing.md) {
                TypeGlyph(symbol: relation.type.symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(relation.title.isEmpty ? relation.type.label : relation.title).font(HearthFont.subheadline)
                    Label(relation.kind.replacingOccurrences(of: "_", with: " "), systemImage: symbol)
                        .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
                Spacer()
            }
            .padding(.vertical, HearthSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
