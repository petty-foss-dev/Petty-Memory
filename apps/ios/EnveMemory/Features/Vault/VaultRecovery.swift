import EnveMemoryKit
import SwiftUI
import UniformTypeIdentifiers

/// Offers a recovery kit while the vault is unlocked: a file plus a one-time code that together can open it again.
struct VaultRecoveryCard: View {
    @Environment(VaultSession.self) private var vault
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label("Recovery kit", systemImage: "key.viewfinder").font(HearthFont.headline)
                Text("If you might forget your passphrase, make a recovery kit: a file and a separate code. With both, and a backup of your library, you can open your secret notes again. Nobody else can reset it for you.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                Button("Make a recovery kit") {
                    do {
                        try vault.makeRecoveryKit()
                    } catch {
                        router.show(error.localizedDescription)
                    }
                }
                .buttonStyle(.hearthSecondary)
                .accessibilityIdentifier("VaultMakeRecoveryKit")
            }
        }
        .sheet(item: Binding(get: { vault.recovery }, set: { if $0 == nil { vault.closeRecovery() } })) { display in
            VaultRecoverySheet(display: display).environment(\.hearth, hearth)
        }
    }
}

/// The code is shown only here and only now; the kit is saved as a file. Both vanish on lock or leaving the app.
private struct VaultRecoverySheet: View {
    let display: VaultSession.RecoveryDisplay

    @Environment(VaultSession.self) private var vault
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var exporting = false
    @State private var savedFile = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Keep the file and the code in different places, for example the file with your backups and the code on paper. Anyone with both can open your secret notes. The code isn't saved anywhere and can't be shown again.")
                        .font(HearthFont.footnote)
                }
                Section("1. Save the recovery file") {
                    Button(savedFile ? "Saved — save another copy" : "Save recovery file…", systemImage: "square.and.arrow.down") { exporting = true }
                        .accessibilityIdentifier("VaultSaveRecoveryFile")
                }
                Section {
                    Text(display.code)
                        .font(HearthFont.monospace)
                        .textSelection(.enabled)
                        .accessibilityLabel("Recovery code")
                        .accessibilityValue(display.code.map(String.init).joined(separator: " "))
                        .accessibilityIdentifier("VaultRecoveryCode")
                    Button("Copy code", systemImage: "doc.on.doc") {
                        UIPasteboard.general.setItems([[UTType.plainText.identifier: display.code]],
                                                      options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(120)])
                        router.show("Copied. It leaves the clipboard in 2 minutes.")
                    }
                } header: {
                    Text("2. Write down the code")
                } footer: {
                    Text("Starts with pmr1_. It opens only this kit.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Recovery kit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { vault.closeRecovery() } }
            }
            .fileExporter(isPresented: $exporting, document: RecoveryKitDocument(data: display.kit), contentType: .json,
                          defaultFilename: "Petty Memory recovery kit.json") { result in
                switch result {
                case .success: savedFile = true
                case .failure(let error): router.show(error.localizedDescription)
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled()
        .vaultShield()
    }
}

/// Opens a recovery kit with its code and unlocks with what's inside. The passphrase is never shown or kept.
struct VaultRecoverForm: View {
    let notes: [Item]

    @Environment(VaultSession.self) private var vault
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var kit: Data?
    @State private var kitName: String?
    @State private var code = ""
    @State private var choosing = false
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Use the recovery file and the code you saved when you made the kit. Both stay on this phone.")
                        .font(HearthFont.footnote)
                }
                Section("Recovery file") {
                    Button(kitName ?? "Choose recovery file…", systemImage: "doc") { choosing = true }
                        .accessibilityIdentifier("VaultChooseRecoveryFile")
                }
                Section("Recovery code") {
                    SecureField("pmr1_…", text: $code)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(HearthFont.monospace)
                        .accessibilityIdentifier("VaultRecoveryCodeField")
                }
                if let error {
                    Section { Text(error).foregroundStyle(hearth.danger) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(hearth.background)
            .navigationTitle("Recover vault")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(working ? "Opening…" : "Open vault", action: recover).disabled(working || kit == nil || code.isEmpty)
                }
            }
            .fileImporter(isPresented: $choosing, allowedContentTypes: [.json, .data]) { result in
                if case .success(let url) = result { read(url) }
            }
        }
        .tint(hearth.accent)
        .vaultShield()
        .onDisappear {
            code = ""
            kit = nil
        }
    }

    private func read(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 1_000_000,
              let data = try? Data(contentsOf: url) else {
            error = VaultError.notARecoveryKit.localizedDescription
            return
        }
        kit = data
        kitName = url.lastPathComponent
        error = nil
    }

    private func recover() {
        guard let kit else { return }
        let entered = code
        code = ""
        working = true
        Task {
            defer { working = false }
            do {
                try await vault.recover(kit: kit, code: entered, notes: notes)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct RecoveryKitDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    let data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
