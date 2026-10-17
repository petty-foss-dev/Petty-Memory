import EnveMemoryKit
import SwiftUI
import UniformTypeIdentifiers

/// One secret note, opened on this phone: its text, its encrypted files and the secret notes inside it.
/// Fetched directly each time through the uncached session; never from the offline copy.
struct VaultNoteView: View {
    let itemID: String

    @Environment(Connection.self) private var connection
    @Environment(VaultSession.self) private var vault
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var detail: ItemDetail?
    @State private var parent: Item?
    @State private var children: [OutlineEntry] = []
    @State private var childTotal = 0
    @State private var error: String?
    @State private var sheet: Sheet?
    @State private var importing = false
    @State private var working: String?
    @State private var removing: Attachment?

    enum Sheet: Identifiable {
        case edit(Item), child, move(Item)
        var id: String {
            switch self {
            case .edit: "edit"
            case .child: "child"
            case .move: "move"
            }
        }
    }

    private var item: Item? { detail?.item }

    var body: some View {
        HearthScreen(overline: "Secret note") {
            if !connection.canUseVault {
                VaultScopeNotice()
            } else if let error {
                ErrorBanner(message: error) { Task { await load() } }
            } else if let item {
                if !vault.isUnlocked {
                    VaultUnlockCard(notes: [item])
                } else if let plain = vault.opened[item.id] {
                    if let parent, parent.isSecret {
                        Button { router.open(.vaultNote(parent.id)) } label: {
                            Label("Inside “\(vault.opened[parent.id]?.title ?? "a secret note")”", systemImage: "arrow.turn.left.up")
                                .font(HearthFont.footnote)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(hearth.accent)
                    }
                    VaultNoteContent(plain: plain)
                    files
                    inside
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if vault.isUnlocked, let item, vault.opened[item.id] != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { sheet = .edit(item) }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("New secret note inside", systemImage: "plus") { sheet = .child }
                        Button("Add a file…", systemImage: "paperclip") { importing = true }
                        Button("Move…", systemImage: "arrow.up.and.down.and.arrow.left.and.right") { sheet = .move(item) }
                        Button("History", systemImage: "clock.arrow.circlepath") { router.open(.history(item.id)) }
                        Button("Lock", systemImage: "lock") { vault.lock() }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("More actions")
                    .accessibilityIdentifier("VaultNoteMenu")
                }
            }
        }
        .sheet(item: $sheet) { sheet in
            Group {
                switch sheet {
                case .edit(let item): VaultEditor(item: item) { _ in Task { await load() } }
                case .child: VaultEditor(item: nil, parentID: itemID) { _ in Task { await load() } }
                case .move(let item): VaultMovePicker(item: item) { Task { await load() } }
                }
            }
            .environment(\.hearth, hearth)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await add(url) } }
        }
        .fileExporter(isPresented: Binding(get: { vault.openedFile != nil }, set: { if !$0 { vault.closeFile() } }),
                      document: vault.openedFile.map { VaultFileDocument(data: $0.file.data) },
                      contentType: vault.openedFile.flatMap { UTType(mimeType: $0.file.mimeType) } ?? .data,
                      defaultFilename: vault.openedFile?.file.filename) { result in
            vault.closeFile()
            if case .failure(let error) = result { router.show(error.localizedDescription) }
        }
        .confirmationDialog("Remove this file?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { attachment in
            Button("Remove", role: .destructive) { Task { await remove(attachment) } }
        } message: { _ in
            Text("It stays in this note's history, so you can bring it back by restoring an earlier version.")
        }
        .vaultShield()
        .task(id: connection.revision) { await load() }
        .task(id: vault.isUnlocked) { await open() }
    }

    @ViewBuilder
    private var files: some View {
        let sealed = detail?.attachments.filter(\.isSealed) ?? []
        HStack {
            Overline("Files")
            Spacer()
            Button("Add a file", systemImage: "plus") { importing = true }
                .font(HearthFont.subheadline)
                .disabled(working != nil)
                .accessibilityIdentifier("VaultAddFile")
        }
        if sealed.isEmpty {
            Text("Files you add are encrypted on this phone, name and type included. Your computer stores only ciphertext.")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
        } else {
            RowStack(data: sealed) { attachment in
                HStack(spacing: HearthSpacing.md) {
                    TypeGlyph(symbol: "lock.doc")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Encrypted file").font(HearthFont.subheadline)
                        Text("\(attachment.size.formatted(.byteCount(style: .file))) sealed · added \(attachment.createdAt.formatted(date: .abbreviated, time: .omitted))")
                            .font(HearthFont.caption)
                            .foregroundStyle(hearth.textTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if working == attachment.id {
                        ProgressView()
                    } else {
                        Button("Save…") { Task { await save(attachment) } }
                            .font(HearthFont.subheadline)
                            .disabled(working != nil)
                            .accessibilityHint("Decrypts the file on this phone and lets you save it")
                        Button(role: .destructive) { removing = attachment } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless)
                            .disabled(working != nil)
                            .accessibilityLabel("Remove file")
                    }
                }
                .padding(.vertical, HearthSpacing.xs)
                .accessibilityElement(children: .contain)
            }
        }
    }

    @ViewBuilder
    private var inside: some View {
        HStack {
            Overline(childTotal == 0 ? "Inside" : childTotal == 1 ? "1 secret note inside" : "\(childTotal) secret notes inside")
            Spacer()
            Button("New", systemImage: "plus") { sheet = .child }
                .font(HearthFont.subheadline)
                .accessibilityLabel("New secret note inside")
        }
        if !children.isEmpty {
            RowStack(data: children) { entry in
                Button { router.open(.vaultNote(entry.id)) } label: {
                    HStack(spacing: HearthSpacing.md) {
                        TypeGlyph(symbol: vault.opened[entry.id] == nil ? "lock.fill" : "lock.open")
                        Text(vault.opened[entry.id].map { $0.title.isEmpty ? "Untitled" : $0.title } ?? "Secret note")
                            .font(HearthFont.cardTitle)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if entry.childCount > 0 {
                            Text("\(entry.childCount) inside").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                        }
                    }
                    .padding(.vertical, HearthSpacing.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if children.count < childTotal {
                Button("Show more (\(childTotal - children.count))") { Task { await loadChildren(more: true) } }
                    .buttonStyle(.hearthSecondary)
            }
        }
    }

    private func load() async {
        guard connection.canUseVault, let client = connection.privateClient else { return }
        do {
            async let loadedDetail = client.send(.item(itemID), as: ItemDetail.self)
            async let entry = client.send(.outlineEntry(itemID), as: OutlineEntry.self)
            let (loaded, placement) = try await (loadedDetail, entry)
            detail = loaded
            parent = nil
            if let parentID = placement.parentId { parent = try? await client.send(.item(parentID), as: ItemDetail.self).item }
            try await fetchChildren(more: false)
            error = nil
            await open()
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            connection.note(error)
        }
    }

    private func fetchChildren(more: Bool) async throws {
        guard let client = connection.privateClient else { return }
        let page = try await client.send(.outline(parent: itemID, offset: more ? children.count : 0, limit: 100), as: OutlinePage.self)
        children = (more ? children : []) + page.items.filter { $0.item.isSecret }
        childTotal = page.total
    }

    private func loadChildren(more: Bool) async {
        do {
            try await fetchChildren(more: more)
            await open()
        } catch {
            router.show(error.localizedDescription)
        }
    }

    /// Opens the note, its secret parent's and children's labels, in memory only.
    private func open() async {
        guard vault.isUnlocked, let item else { return }
        do {
            _ = try await vault.open(item)
            for other in [parent].compactMap(\.self) + children.map(\.item) where other.isSecret && vault.opened[other.id] == nil {
                _ = try? await vault.open(other)
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Read, sealed and sent here; the name, type and bytes never reach the server in the clear.
    private func add(_ url: URL) async {
        guard let client = connection.privateClient else { return }
        working = "adding"
        defer { working = nil }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > VaultCrypto.maxFileBytes { throw VaultError.fileTooLarge }
            var data = try Data(contentsOf: url)
            defer { data.resetBytes(in: data.startIndex..<data.endIndex) }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            let file = try VaultFile(filename: url.lastPathComponent, mimeType: type, data: data)
            let attachmentID = UUIDv7.make()
            let envelope = try await vault.sealFile(file, itemID: itemID, attachmentID: attachmentID)
            _ = try await client.send(.putSealedAttachment(itemID: itemID, attachmentID: attachmentID, envelope: envelope), as: Attachment.self)
            connection.didWrite()
            router.show("File encrypted and saved")
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            router.show(error.localizedDescription)
        }
    }

    /// Downloads the ciphertext and decrypts it here, then offers to save it. It's never previewed or opened in the app.
    private func save(_ attachment: Attachment) async {
        guard let client = connection.privateClient else { return }
        working = attachment.id
        defer { working = nil }
        do {
            let envelope = try await client.send(.sealedAttachment(itemID: itemID, attachmentID: attachment.id), as: SecretEnvelope.self)
            try await vault.openFile(envelope, itemID: itemID, attachmentID: attachment.id)
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            router.show(error.localizedDescription)
        }
    }

    private func remove(_ attachment: Attachment) async {
        guard let client = connection.privateClient else { return }
        working = attachment.id
        defer { working = nil }
        do {
            let result = try await client.send(.removeSealedAttachment(itemID: itemID, attachmentID: attachment.id), as: AttachmentRemoval.self)
            connection.didWrite()
            router.show(result.removed ? "File removed. Restore an earlier version to bring it back." : "That file was already gone.")
        } catch {
            connection.note(error)
            router.show(error.localizedDescription)
        }
    }
}

/// Decrypted bytes handed to the system's save sheet; they live only as long as the sheet.
struct VaultFileDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.data]
    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

private struct VaultNoteContent: View {
    let plain: VaultCrypto.Plain

    @Environment(\.hearth) private var hearth

    var body: some View {
        Text(plain.title.isEmpty ? "Untitled" : plain.title)
            .font(HearthFont.itemTitle)
            .textSelection(.enabled)
            .accessibilityAddTraits(.isHeader)
        HearthCard(padding: HearthSpacing.xl) {
            Text(plain.body.isEmpty ? "No text." : plain.body)
                .font(HearthFont.body)
                .foregroundStyle(plain.body.isEmpty ? hearth.textTertiary : hearth.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        Label("Encrypted on this phone. Your computer and backups hold only ciphertext.", systemImage: "lock.shield")
            .font(HearthFont.caption)
            .foregroundStyle(hearth.textTertiary)
    }
}

/// Creates or rewrites a secret note. Sealed here, sent directly, and dropped if the vault locks mid-edit.
struct VaultEditor: View {
    let item: Item?
    /// For a new note: the note it goes inside, or nil for the top level.
    var parentID: String?
    let onSaved: (Item) -> Void

    @Environment(Connection.self) private var connection
    @Environment(VaultSession.self) private var vault
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var title = ""
    @State private var text = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    TextField("Secret text", text: $text, axis: .vertical)
                        .lineLimit(6...20)
                } footer: {
                    Text("Encrypted on this phone before it's sent. Never saved offline or queued; you need a connection to save.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(hearth.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.sentences)
            .navigationTitle(item != nil ? "Edit secret note" : parentID == nil ? "New secret note" : "New secret note inside")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { close() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { save() }
                        .disabled(saving || (title.trimmingCharacters(in: .whitespaces).isEmpty && text.trimmingCharacters(in: .whitespaces).isEmpty))
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(saving)
        .vaultShield()
        .onAppear {
            if let item, let plain = vault.opened[item.id] {
                title = plain.title
                text = plain.body
            }
        }
        .onChange(of: vault.isUnlocked) { _, unlocked in
            if !unlocked { close() }
        }
    }

    private func close() {
        title = ""
        text = ""
        dismiss()
    }

    private func save() {
        guard let client = connection.privateClient else { return }
        saving = true
        let plain = VaultCrypto.Plain(title: title.trimmingCharacters(in: .whitespacesAndNewlines), body: text.trimmingCharacters(in: .whitespacesAndNewlines))
        Task {
            defer { saving = false }
            do {
                let id = item?.id ?? UUIDv7.make()
                let envelope = try await vault.seal(plain, id: id)
                let endpoint = item == nil
                    ? try Endpoint.createSealedNote(SealedNoteRequest(id: id, envelope: envelope, parentId: parentID))
                    : try Endpoint.updateSealedNote(id, envelope: envelope)
                let saved = try await client.send(endpoint, as: ItemDetail.self).item
                connection.didWrite()
                router.show(item == nil ? "Secret note saved" : "Secret note updated")
                onSaved(saved)
                close()
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.localizedDescription
            }
        }
    }
}
