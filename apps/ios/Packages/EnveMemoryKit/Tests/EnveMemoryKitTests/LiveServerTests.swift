import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct LiveServerTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["MEMORY_TEST_SERVER"] != nil))
    func nativeEncryptedFilesCrossTheRealAPIAndRestoreFromHistory() async throws {
        let environment = ProcessInfo.processInfo.environment
        let address = try #require(environment["MEMORY_TEST_SERVER"])
        let base = try #require(URL(string: address))
        let token = try #require(environment["MEMORY_TEST_TOKEN"])
        let client = APIClient(baseURL: base, token: token, timeout: 10)
        let fixture = CloseoutFixture.shared
        let id = UUIDv7.make()
        let attachmentID = UUIDv7.make()
        let salt = VaultCrypto.newSalt()
        let key = VaultCrypto.deriveKey(passphrase: fixture.passphrase, salt: salt)
        let envelope = try VaultCrypto.seal(.init(title: "Native API contract", body: "Synthetic native contract text"), id: id, key: key, salt: salt)
        let note = try await client.send(try .createSealedNote(.init(id: id, envelope: envelope, tags: ["native-contract-test"], parentId: fixture.note.id)), as: ItemDetail.self)
        #expect(note.item.title == "Secret note" && note.item.body.isEmpty)
        let placement = try await client.send(.outlineEntry(id), as: OutlineEntry.self)
        #expect(placement.parentId == fixture.note.id)
        let original = try VaultFile(filename: "Native receipt é.bin", mimeType: "application/octet-stream", data: Data((0...255).map(UInt8.init)))
        let sealed = try VaultCrypto.sealFile(original, itemID: id, attachmentID: attachmentID, key: key, salt: salt)
        let attached = try await client.send(try .putSealedAttachment(itemID: id, attachmentID: attachmentID, envelope: sealed), as: Attachment.self)
        #expect(attached.filename == "Encrypted attachment.pmv" && attached.isSealed)
        let downloaded = try await client.send(.sealedAttachment(itemID: id, attachmentID: attachmentID), as: SecretEnvelope.self)
        let opened = try VaultCrypto.openFile(downloaded, itemID: id, attachmentID: attachmentID, key: key)
        #expect(opened.filename == original.filename && opened.data == original.data)
        let history = try await client.send(.versions(id), as: VersionPage.self)
        let version = try #require(history.items.first)
        let removed = try await client.send(.removeSealedAttachment(itemID: id, attachmentID: attachmentID), as: AttachmentRemoval.self)
        #expect(removed.removed)
        let restored = try await client.send(.restoreSecretVersion(version.id), as: RestoreResult.self)
        #expect(restored.restored == 1 && (restored.missingFiles ?? []).isEmpty)
        let restoredEnvelope = try await client.send(.sealedAttachment(itemID: id, attachmentID: attachmentID), as: SecretEnvelope.self)
        #expect(try VaultCrypto.openFile(restoredEnvelope, itemID: id, attachmentID: attachmentID, key: key).data == original.data)
    }
}
