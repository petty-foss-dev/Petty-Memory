import CryptoKit
import EnveMemoryKit
import Foundation
import Observation

// Decrypted content stays in memory and is discarded on lock or background.
@Observable
final class VaultSession {
    /// A file opened for saving out of the app; its bytes are overwritten on lock.
    struct OpenedFile: Identifiable {
        let id: String
        var file: VaultFile
    }

    /// A recovery kit just made: the code is shown this once, the kit offered as a file.
    struct RecoveryDisplay: Identifiable {
        let id = UUID()
        let code: String
        let kit: Data
    }

    private(set) var isUnlocked = false
    /// Opened notes by item id. Never written anywhere.
    private(set) var opened: [String: VaultCrypto.Plain] = [:]
    private(set) var openedFile: OpenedFile?
    private(set) var recovery: RecoveryDisplay?

    @ObservationIgnored private let keyring = VaultKeyring()
    @ObservationIgnored private var generation: Int?
    @ObservationIgnored private var salt: String?

    /// Checks the passphrase against an existing note when there is one; a first passphrase is confirmed by the caller.
    func unlock(_ passphrase: String, notes: [Item]) async throws {
        let sample = notes.lazy.compactMap { item in item.metadata.vault.flatMap { $0.isPortable ? (id: item.id, envelope: $0) : nil } }.first
        let unlocked = try await keyring.unlock(passphrase, checking: sample)
        salt = sample?.envelope.salt ?? VaultCrypto.newSalt().base64EncodedString()
        generation = unlocked
        isUnlocked = true
    }

    /// Opens a recovery kit with its code, then unlocks exactly as the passphrase inside would. The passphrase is never returned.
    func recover(kit: Data, code: String, notes: [Item]) async throws {
        try await unlock(VaultRecovery.passphrase(fromKit: kit, code: code), notes: notes)
    }

    func open(_ item: Item) async throws -> VaultCrypto.Plain {
        guard let envelope = item.metadata.vault else { throw VaultError.damaged }
        guard envelope.isPortable else { throw VaultError.legacyEnvelope }
        let plain = try VaultCrypto.open(envelope, id: item.id, key: try await key(for: envelope.salt))
        opened[item.id] = plain
        return plain
    }

    func seal(_ plain: VaultCrypto.Plain, id: String) async throws -> SecretEnvelope {
        let (key, salt) = try await sealingKey()
        let envelope = try VaultCrypto.seal(plain, id: id, key: key, salt: salt)
        opened[id] = plain
        return envelope
    }

    func sealFile(_ file: VaultFile, itemID: String, attachmentID: String) async throws -> SecretEnvelope {
        let (key, salt) = try await sealingKey()
        let started = generation
        let envelope = try await Task.detached(priority: .userInitiated) {
            try VaultCrypto.sealFile(file, itemID: itemID, attachmentID: attachmentID, key: key, salt: salt)
        }.value
        guard started == generation else { throw CancellationError() }
        return envelope
    }

    /// Decrypts a file for saving out; it stays only until it's saved, dismissed or the vault locks.
    func openFile(_ envelope: SecretEnvelope, itemID: String, attachmentID: String) async throws {
        let key = try await key(for: envelope.salt)
        let started = generation
        var file = try await Task.detached(priority: .userInitiated) {
            try VaultCrypto.openFile(envelope, itemID: itemID, attachmentID: attachmentID, key: key)
        }.value
        guard started == generation, isUnlocked else {
            file.erase()
            throw CancellationError()
        }
        closeFile()
        openedFile = OpenedFile(id: attachmentID, file: file)
    }

    func closeFile() {
        openedFile?.file.erase()
        openedFile = nil
    }

    func makeRecoveryKit() throws {
        guard let generation else { throw VaultError.wrongPassphrase }
        let made = try keyring.recoveryKit(generation: generation)
        recovery = RecoveryDisplay(code: made.code, kit: try VaultRecovery.file(made.kit))
    }

    func closeRecovery() {
        recovery = nil
    }

    func lock() {
        keyring.lock()
        generation = nil
        salt = nil
        opened = [:]
        closeFile()
        recovery = nil
        isUnlocked = false
    }

    private func key(for salt: String) async throws -> SymmetricKey {
        guard let generation else { throw VaultError.wrongPassphrase }
        let key = try await keyring.key(for: salt, generation: generation)
        guard generation == self.generation else { throw CancellationError() }
        return key
    }

    private func sealingKey() async throws -> (SymmetricKey, Data) {
        guard let salt, let saltData = Data(base64Encoded: salt) else { throw VaultError.wrongPassphrase }
        return (try await key(for: salt), saltData)
    }
}
