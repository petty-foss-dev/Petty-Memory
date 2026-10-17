import CryptoKit
import Foundation
import Testing
@testable import EnveMemoryKit

/// Copied unchanged from packages/core/test/fixtures/vault-closeout-v1.json, generated independently with Node crypto.
struct CloseoutFixture: Decodable {
    struct Note: Decodable { let id: String; let envelope: SecretEnvelope; let plaintext: VaultCrypto.Plain }
    struct File: Decodable {
        let itemId: String
        let attachmentId: String
        let aad: String
        let envelope: SecretEnvelope
        let filename: String
        let mimeType: String
        let metadataLength: Int
        let dataBase64: String
        let dataSha256: String
    }
    struct Recovery: Decodable { let aad: String; let kit: VaultRecoveryKit; let code: String }

    let passphrase: String
    let note: Note
    let file: File
    let recovery: Recovery

    static let shared: CloseoutFixture = try! JSONDecoder().decode(CloseoutFixture.self, from: Fixture.data("vault-closeout-v1"))
    static let key = VaultCrypto.deriveKey(passphrase: shared.passphrase, salt: Data(base64Encoded: shared.note.envelope.salt)!)
}

@Suite struct VaultFileCryptoTests {
    let fixture = CloseoutFixture.shared
    let key = CloseoutFixture.key

    @Test func opensTheFixedNodeNoteAndFile() throws {
        #expect(try VaultCrypto.open(fixture.note.envelope, id: fixture.note.id, key: key) == fixture.note.plaintext)
        #expect(fixture.file.aad == String(decoding: VaultCrypto.fileAAD(itemID: fixture.file.itemId, attachmentID: fixture.file.attachmentId), as: UTF8.self))
        let file = try VaultCrypto.openFile(fixture.file.envelope, itemID: fixture.file.itemId, attachmentID: fixture.file.attachmentId, key: key)
        #expect(file.filename == fixture.file.filename && file.mimeType == fixture.file.mimeType)
        #expect(file.data == Data(base64Encoded: fixture.file.dataBase64))
        #expect(SHA256.hash(data: file.data).map { String(format: "%02x", $0) }.joined() == fixture.file.dataSha256)

        let frame = try VaultCrypto.openBytes(fixture.file.envelope, aad: Data(fixture.file.aad.utf8), key: key)
        #expect(frame.prefix(5) == Data("PMVF1".utf8) && frame[5..<9] == Data([0, 0, 0, UInt8(fixture.file.metadataLength)]))
    }

    @Test func aFileOpensOnlyForItsOwnNoteAttachmentAndPassphrase() throws {
        let envelope = fixture.file.envelope
        let other = "019a0000-0000-7000-8000-00000000f003"
        #expect(throws: VaultError.damagedFile) { try VaultCrypto.openFile(envelope, itemID: other, attachmentID: fixture.file.attachmentId, key: key) }
        #expect(throws: VaultError.damagedFile) { try VaultCrypto.openFile(envelope, itemID: fixture.file.itemId, attachmentID: other, key: key) }
        #expect(throws: VaultError.damagedFile) {
            try VaultCrypto.openFile(envelope, itemID: fixture.file.itemId, attachmentID: fixture.file.attachmentId, key: SymmetricKey(size: .bits256))
        }
        // A note's envelope (AAD = its id) isn't a file, and a file isn't a note.
        #expect(throws: VaultError.damagedFile) { try VaultCrypto.openFile(fixture.note.envelope, itemID: fixture.note.id, attachmentID: fixture.file.attachmentId, key: key) }
        #expect(throws: VaultError.damaged) { try VaultCrypto.open(envelope, id: fixture.file.itemId, key: key) }
    }

    @Test func sealedFilesRoundTripWithAFreshIVAndHideTheirNameAndType() throws {
        let salt = Data(base64Encoded: fixture.note.envelope.salt)!
        let bytes = Data((0..<1000).map { UInt8($0 % 251) })
        let file = try VaultFile(filename: "Tax return 2026 é.pdf", mimeType: "Application/PDF", data: bytes)
        let ids = (item: UUIDv7.make(), attachment: UUIDv7.make())
        let one = try VaultCrypto.sealFile(file, itemID: ids.item, attachmentID: ids.attachment, key: key, salt: salt)
        let two = try VaultCrypto.sealFile(file, itemID: ids.item, attachmentID: ids.attachment, key: key, salt: salt)
        #expect(one.iv != two.iv && one.isPortable && one.salt == fixture.note.envelope.salt)
        let wire = try bodyString(.putSealedAttachment(itemID: ids.item, attachmentID: ids.attachment, envelope: one))
        #expect(!wire.contains("Tax") && !wire.contains("pdf") && !wire.contains("PDF"))
        let opened = try VaultCrypto.openFile(one, itemID: ids.item, attachmentID: ids.attachment, key: key)
        #expect(opened.filename == "Tax return 2026 é.pdf" && opened.mimeType == "application/pdf" && opened.data == bytes)

        let meta = try VaultCrypto.openBytes(one, aad: VaultCrypto.fileAAD(itemID: ids.item, attachmentID: ids.attachment), key: key)
        #expect(String(decoding: meta.dropFirst(9).prefix(Int(meta[8])), as: UTF8.self) == #"{"filename":"Tax return 2026 é.pdf","mimeType":"application/pdf"}"#)
    }

    @Test func filesOutsideTheFrameLimitsAreRefusedBeforeSealing() throws {
        #expect(throws: VaultError.emptyFile) { try VaultFile(filename: "a.txt", mimeType: "text/plain", data: Data()) }
        #expect(throws: VaultError.fileTooLarge) { try VaultFile(filename: "a.bin", mimeType: "application/octet-stream", data: Data(count: VaultCrypto.maxFileBytes + 1)) }
        for name in ["", " ", ".", "..", "a/b", "a\\b", "line\nbreak", String(repeating: "x", count: 256)] {
            #expect(throws: VaultError.unsafeFileName) { try VaultFile(filename: name, mimeType: "text/plain", data: Data([1])) }
        }
        #expect(try VaultFile(filename: "notes", mimeType: "not a type", data: Data([1])).mimeType == "application/octet-stream")
        #expect(try VaultFile(filename: "max.bin", mimeType: "application/octet-stream", data: Data(count: VaultCrypto.maxFileBytes)).data.count == VaultCrypto.maxFileBytes)
    }
}

@Suite struct VaultRecoveryTests {
    let fixture = CloseoutFixture.shared

    @Test func opensTheFixedNodeKitWithItsCode() throws {
        let file = try VaultRecovery.file(fixture.recovery.kit)
        #expect(try VaultRecovery.passphrase(fromKit: file, code: fixture.recovery.code) == fixture.passphrase.precomposedStringWithCompatibilityMapping)
        #expect(try VaultRecovery.passphrase(fromKit: file, code: "  \(fixture.recovery.code)\n") == fixture.passphrase.precomposedStringWithCompatibilityMapping)
        #expect(fixture.recovery.aad == String(decoding: VaultRecovery.aad, as: UTF8.self))
    }

    @Test func wrongCodesKitsAndShapesFailWithoutRevealingAnything() throws {
        let file = try VaultRecovery.file(fixture.recovery.kit)
        let otherCode = VaultRecovery.make(passphraseOrThrow: "another")
        #expect(throws: VaultError.recoveryCodeMismatch) { try VaultRecovery.passphrase(fromKit: file, code: otherCode) }
        for code in ["", "pmr1_", String(fixture.recovery.code.dropLast()), fixture.recovery.code + "A", fixture.recovery.code.replacingOccurrences(of: "pmr1_", with: "pmr2_"),
                     String(fixture.recovery.code.dropLast()) + "9"] {
            #expect(throws: VaultError.recoveryCodeShape) { try VaultRecovery.passphrase(fromKit: file, code: code) }
        }
        let kit = fixture.recovery.kit
        let wrongKind = VaultRecoveryKit(v: 1, kind: "something-else", iv: kit.iv, tag: kit.tag, data: kit.data)
        let newer = VaultRecoveryKit(v: 2, kind: kit.kind, iv: kit.iv, tag: kit.tag, data: kit.data)
        let shortIV = VaultRecoveryKit(v: 1, kind: kit.kind, iv: "AAAA", tag: kit.tag, data: kit.data)
        let tampered = VaultRecoveryKit(v: 1, kind: kit.kind, iv: kit.iv, tag: Data(count: 16).base64EncodedString(), data: kit.data)
        for bad in [wrongKind, newer, shortIV] {
            #expect(throws: VaultError.notARecoveryKit) { try VaultRecovery.passphrase(fromKit: VaultRecovery.file(bad), code: fixture.recovery.code) }
        }
        #expect(throws: VaultError.notARecoveryKit) { try VaultRecovery.passphrase(fromKit: Data("{}".utf8), code: fixture.recovery.code) }
        #expect(throws: VaultError.recoveryCodeMismatch) { try VaultRecovery.passphrase(fromKit: VaultRecovery.file(tampered), code: fixture.recovery.code) }
    }

    @Test func newKitsUseAFreshRandomCodeAndTheContractShape() throws {
        let (kit, code) = try VaultRecovery.make(passphrase: "ﬁxture Ⅸ café")
        let (again, otherCode) = try VaultRecovery.make(passphrase: "ﬁxture Ⅸ café")
        #expect(code.wholeMatch(of: /pmr1_[A-Za-z0-9_-]{43}/) != nil && code != otherCode && kit.iv != again.iv)
        #expect(kit.v == 1 && kit.kind == "petty-memory-vault-recovery" && Data(base64Encoded: kit.iv)?.count == 12 && Data(base64Encoded: kit.tag)?.count == 16)
        let file = try VaultRecovery.file(kit)
        #expect(!String(decoding: file, as: UTF8.self).contains("café") && !String(decoding: file, as: UTF8.self).contains(code))
        #expect(try VaultRecovery.passphrase(fromKit: file, code: code) == "fixture IX café")
        #expect(throws: VaultError.recoveryCodeMismatch) { try VaultRecovery.passphrase(fromKit: file, code: otherCode) }
    }
}

@Suite struct VaultRouteTests {
    @Test func sealedFilesNestingAndHistoryUseTheVaultRoutesOnly() throws {
        let envelope = CloseoutFixture.shared.file.envelope
        let put = try Endpoint.putSealedAttachment(itemID: "i 1", attachmentID: "a1", envelope: envelope)
        #expect(put.method == "PUT" && put.path == "/vault/items/i%201/attachments/a1" && put.isOnlineOnly)
        let body = try JSONDecoder().decode([String: JSONValue].self, from: #require(put.body))
        #expect(Set(body.keys) == ["v", "kdf", "salt", "iv", "tag", "data"])
        #expect(Endpoint.sealedAttachment(itemID: "i1", attachmentID: "a1").method == "GET")
        let remove = Endpoint.removeSealedAttachment(itemID: "i1", attachmentID: "a1")
        #expect(remove.method == "DELETE" && remove.path == "/vault/items/i1/attachments/a1" && remove.isOnlineOnly)
        #expect(!ResponseCache.isCacheable(.sealedAttachment(itemID: "i1", attachmentID: "a1")))
        #expect(try JSONCoding.makeDecoder().decode(AttachmentRemoval.self, from: Data(#"{"removed":true}"#.utf8)).removed)

        let nested = try bodyString(.createSealedNote(SealedNoteRequest(id: "c1", envelope: envelope, parentId: "p1")))
        #expect(nested.contains(#""parentId":"p1""#))
        #expect(!(try bodyString(.createSealedNote(SealedNoteRequest(id: "c1", envelope: envelope)))).contains("parentId"))
        let sealed = try JSONCoding.makeDecoder().decode(Attachment.self, from: Data(#"{"id":"a1","sha256":"00","filename":"Encrypted attachment.pmv","mimeType":"application/vnd.petty-memory.vault+json","size":656,"createdAt":"2026-10-17T10:00:00.000Z"}"#.utf8))
        #expect(sealed.isSealed)
    }
}

@MainActor @Suite struct VaultKeyringTests {
    /// A stand-in for PBKDF2 that waits until released, so a lock can land mid-derivation.
    final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var open = false
        func release() { lock.withLock { open = true } }
        func derive(_ passphrase: String, _ salt: Data) -> SymmetricKey {
            while !lock.withLock({ open }) { Thread.sleep(forTimeInterval: 0.002) }
            return SymmetricKey(data: SHA256.hash(data: Data((passphrase + salt.base64EncodedString()).utf8)))
        }
    }

    @Test func lockingMidDerivationRejectsTheStaleKeyAndForgetsEverything() async throws {
        let gate = Gate()
        let keyring = VaultKeyring(derive: gate.derive)
        let generation = try await keyring.unlock("passphrase", checking: nil)
        let pending = Task { try await keyring.key(for: "AAAAAAAAAAAAAAAAAAAAAA==", generation: generation) }
        try await Task.sleep(for: .milliseconds(20))
        keyring.lock()
        gate.release()
        await #expect(throws: CancellationError.self) { try await pending.value }
        #expect(!keyring.isUnlocked)
        await #expect(throws: CancellationError.self) { try await keyring.key(for: "AAAAAAAAAAAAAAAAAAAAAA==", generation: generation) }
        #expect(throws: CancellationError.self) { try keyring.recoveryKit(generation: generation) }

        let next = try await keyring.unlock("passphrase", checking: nil)
        #expect(next == generation + 1)
        #expect(try keyring.recoveryKit(generation: next).code.hasPrefix("pmr1_"))
    }

    @Test func unlockingChecksThePassphraseAgainstASealedNote() async throws {
        let fixture = CloseoutFixture.shared
        let derive: @Sendable (String, Data) -> SymmetricKey = { passphrase, salt in
            passphrase.precomposedStringWithCompatibilityMapping == fixture.passphrase.precomposedStringWithCompatibilityMapping
                ? CloseoutFixture.key : SymmetricKey(data: SHA256.hash(data: salt))
        }
        let keyring = VaultKeyring(derive: derive)
        await #expect(throws: VaultError.wrongPassphrase) { try await keyring.unlock("wrong", checking: (fixture.note.id, fixture.note.envelope)) }
        #expect(!keyring.isUnlocked)
        let generation = try await keyring.unlock(fixture.passphrase, checking: (fixture.note.id, fixture.note.envelope))
        let key = try await keyring.key(for: fixture.file.envelope.salt, generation: generation)
        #expect(try VaultCrypto.openFile(fixture.file.envelope, itemID: fixture.file.itemId, attachmentID: fixture.file.attachmentId, key: key).filename == fixture.file.filename)
        // Recovering is opening the kit and unlocking with what's inside; the passphrase itself never leaves.
        let recovered = try VaultRecovery.passphrase(fromKit: VaultRecovery.file(fixture.recovery.kit), code: fixture.recovery.code)
        keyring.lock()
        #expect(try await keyring.unlock(recovered, checking: (fixture.note.id, fixture.note.envelope)) == generation + 1)
    }
}

extension VaultRecovery {
    static func make(passphraseOrThrow passphrase: String) -> String { (try? make(passphrase: passphrase).code) ?? "" }
}
