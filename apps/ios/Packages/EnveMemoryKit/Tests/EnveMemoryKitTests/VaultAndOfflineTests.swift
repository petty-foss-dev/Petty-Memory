import CryptoKit
import Foundation
import Testing
@testable import EnveMemoryKit

@Suite struct VaultCryptoTests {
    static let passphrase = "ﬁxture Ⅸ café"
    static let salt = Data((0..<16).map { UInt8($0) })
    static let key = VaultCrypto.deriveKey(passphrase: passphrase, salt: salt)
    static let id = "01920000-0000-7000-8000-000000000001"

    static func bytes(_ key: SymmetricKey) -> Data { key.withUnsafeBytes { Data($0) } }

    /// RFC 8018 PBKDF2 written against CryptoKit's HMAC, independent of the CommonCrypto call under test.
    static func referencePBKDF2(_ password: Data, salt: Data, iterations: Int) -> Data {
        let key = SymmetricKey(data: password)
        var u = Data(HMAC<SHA256>.authenticationCode(for: salt + [0, 0, 0, 1], using: key))
        var t = [UInt8](u)
        for _ in 1..<iterations {
            u = Data(HMAC<SHA256>.authenticationCode(for: u, using: key))
            for index in 0..<32 { t[index] ^= u[index] }
        }
        return Data(t)
    }

    @Test func derivesPBKDF2SHA256With600kRoundsOverNFKC() {
        let normalized = "fixture IX café"
        #expect(Self.passphrase.precomposedStringWithCompatibilityMapping == normalized)
        let expected = Self.referencePBKDF2(Data(normalized.utf8), salt: Self.salt, iterations: 600_000)
        #expect(Self.bytes(Self.key) == expected)
        #expect(expected.base64EncodedString() == "BJgBvri88v3GuyTPQjktSm+TkcwmHIyR1j2ARFi+YU8=")
        #expect(Self.bytes(Self.key).count == 32)

        let decomposed = "\u{FB01}xture \u{2168} cafe\u{0301}"
        #expect(Self.bytes(VaultCrypto.deriveKey(passphrase: decomposed, salt: Self.salt)) == expected)
        #expect(VaultCrypto.newSalt().count == 16 && VaultCrypto.newSalt() != VaultCrypto.newSalt())
    }

    @Test func sealedEnvelopeHasThePortableShapeAndBindsTheId() throws {
        let plain = VaultCrypto.Plain(title: "Router admin", body: "fixture text")
        let envelope = try VaultCrypto.seal(plain, id: Self.id, key: Self.key, salt: Self.salt)
        #expect(envelope.v == 1 && envelope.isPortable)
        #expect(envelope.kdf == SecretEnvelope.KDF(name: "pbkdf2", hash: "sha256", iterations: 600_000, N: nil, r: nil, p: nil))
        #expect(Data(base64Encoded: envelope.salt) == Self.salt)
        #expect(Data(base64Encoded: envelope.iv)?.count == 12)
        #expect(Data(base64Encoded: envelope.tag)?.count == 16)
        #expect(try VaultCrypto.seal(plain, id: Self.id, key: Self.key, salt: Self.salt).iv != envelope.iv)

        let wire = String(decoding: try JSONCoding.makeEncoder().encode(envelope), as: UTF8.self)
        #expect(wire.contains(#""kdf":{"hash":"sha256","iterations":600000,"name":"pbkdf2"}"#))
        #expect(!wire.contains("Router") && !wire.contains("fixture"))

        #expect(try VaultCrypto.open(envelope, id: Self.id, key: Self.key) == plain)
        #expect(throws: VaultError.damaged) { try VaultCrypto.open(envelope, id: "01920000-0000-7000-8000-000000000002", key: Self.key) }
        #expect(throws: VaultError.damaged) { try VaultCrypto.open(envelope, id: Self.id, key: SymmetricKey(size: .bits256)) }
        let tampered = SecretEnvelope(v: 1, kdf: envelope.kdf, salt: envelope.salt, iv: envelope.iv,
                                      tag: Data(repeating: 0, count: 16).base64EncodedString(), data: envelope.data)
        #expect(throws: VaultError.damaged) { try VaultCrypto.open(tampered, id: Self.id, key: Self.key) }
    }

    // Generated independently with Node crypto, binding the fixed item id as AAD.
    @Test func opensAnotherClientsEnvelopeAndRefusesLegacyOnes() throws {
        let json = #"{"v":1,"kdf":{"name":"pbkdf2","hash":"sha256","iterations":600000},"salt":"AAECAwQFBgcICQoLDA0ODw==","iv":"oKGio6Slpqeoqaqr","tag":"aawlgLjn2no1TdIF0BewPA==","data":"AmAZxBaaJpSsaq9TH3uh/Qi6omceKTbcA3XG5wCC4XNrrEvGsRicksQBDomQZA=="}"#
        let item = try JSONCoding.makeDecoder().decode(Item.self, from: Data(itemJSON(id: Self.id, title: "Secret note", metadata: #"{"secret":true,"vault":\#(json)}"#).utf8))
        #expect(item.isSecret)
        let envelope = try #require(item.metadata.vault)
        #expect(try VaultCrypto.open(envelope, id: item.id, key: Self.key) == VaultCrypto.Plain(title: "Router admin", body: "fixture text"))

        let scrypt = try JSONDecoder().decode(SecretEnvelope.self, from: Data(#"{"v":1,"kdf":{"name":"scrypt","N":32768,"r":8,"p":1},"salt":"AA==","iv":"AA==","tag":"AA==","data":"AA=="}"#.utf8))
        #expect(!scrypt.isPortable)
        #expect(throws: VaultError.legacyEnvelope) { try VaultCrypto.open(scrypt, id: Self.id, key: Self.key) }
        let weaker = SecretEnvelope(v: 1, kdf: .init(name: "pbkdf2", hash: "sha256", iterations: 100_000, N: nil, r: nil, p: nil),
                                    salt: envelope.salt, iv: envelope.iv, tag: envelope.tag, data: envelope.data)
        #expect(throws: VaultError.legacyEnvelope) { try VaultCrypto.open(weaker, id: Self.id, key: Self.key) }
    }

    @Test func uuidV7IsTimeOrderedAndWellFormed() {
        let at = Date(timeIntervalSince1970: 1_790_000_000.5)
        let id = UUIDv7.make(now: at)
        #expect(id.wholeMatch(of: /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/) != nil)
        #expect(id.replacing("-", with: "").prefix(12) == String(format: "%012llx", UInt64(1_790_000_000_500)))
        #expect(UUIDv7.make(now: at) != id)
        #expect(UUIDv7.make(now: at.addingTimeInterval(0.002)) > id)
    }

    @Test func sealedWritesCarryCiphertextOnlyAndNeverQueue() async throws {
        let id = UUIDv7.make()
        let envelope = try VaultCrypto.seal(.init(title: "Bank PIN", body: "plain words"), id: id, key: Self.key, salt: Self.salt)
        let create = try Endpoint.createSealedNote(SealedNoteRequest(id: id, envelope: envelope, project: "p1", tags: ["home"]))
        let update = try Endpoint.updateSealedNote(id, envelope: envelope)
        #expect(create.method == "POST" && create.path == "/vault/sealed-items")
        #expect(update.method == "PATCH" && update.path == "/vault/sealed-items/\(id)")

        let created = try JSONDecoder().decode([String: JSONValue].self, from: #require(create.body))
        #expect(Set(created.keys) == ["id", "envelope", "project", "tags"])
        #expect(try JSONDecoder().decode([String: JSONValue].self, from: #require(update.body)).keys.sorted() == ["envelope"])
        for endpoint in [create, update] {
            let text = try bodyString(endpoint)
            #expect(!text.contains("Bank PIN") && !text.contains("plain words") && !text.contains("café") && !text.contains("fixture"))
            #expect(endpoint.idempotencyKey == nil && endpoint.isOnlineOnly)
        }

        let directory = TestDirectory.make("outbox")
        let outbox = Outbox(directory: directory)
        for endpoint in [create, update] {
            await #expect(throws: OutboxError.onlineOnly) { try await outbox.enqueue(endpoint, kind: .note, title: "Secret note") }
        }
        #expect(await outbox.entries().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }
}

@Suite struct OnlineOnlyTests {
    @Test func outboxRefusesVaultAIAndShareCreationButQueuesOrdinaryEdits() async throws {
        let outbox = Outbox(directory: TestDirectory.make("outbox"))
        let refused: [Endpoint] = [
            Endpoint(method: "POST", path: "/vault/unlock", body: Data(#"{"passphrase":"x"}"#.utf8)),
            try .proposeEdit(rootId: "r1", instruction: "tidy"),
            try .undoEdit(.object([:])),
            try .createShare(rootId: "r1", excludedIds: [], expiresAt: nil),
        ]
        for endpoint in refused {
            await #expect(throws: OutboxError.onlineOnly) { try await outbox.enqueue(endpoint, kind: .edit, title: endpoint.path) }
        }

        let queued: [Endpoint] = [
            try .updateItem("i1", ItemUpdate(title: "New", baseTitle: "Old")),
            try .check("i1", true),
            try .updatePresentation("i1", .init(attention: .high)),
            try .moveOutlineItem("i1", parentId: nil, beforeId: nil),
            try .createOutlineNote(OutlineNoteRequest(parentId: "p1", title: "n")),
            try .insertReference("i1", to: "i2", label: nil),
            try .relate("i1", to: "i2", kind: "related_to"),
            .resetChecklist("i1"),
            .revokeShare("s1"),
            .restoreVersion("v1"),
        ]
        for endpoint in queued {
            let entry = try await outbox.enqueue(endpoint, kind: .edit, title: endpoint.path)
            #expect(entry.idempotencyKey == endpoint.idempotencyKey)
        }
        #expect(Set(await outbox.entries().map(\.endpoint)) == Set(queued))
    }
}

@Suite struct ResponseCacheTests {
    @Test func allowlistKeepsPrivateAndVolatileReadsOut() throws {
        let cacheable: [Endpoint] = [
            .items(), .item("i1"), .outline(parent: nil), .outlineEntry("i1"), .ancestors("i1"), .projects, .briefing("garage"),
            .tasks(), .search("relay"), .reminders(), .references("i1"), .checklist("i1"), .presentation("i1"),
            .items(ItemFilter(shelf: .review)),
        ]
        let refused: [Endpoint] = [
            .secretItems(), Endpoint(path: "/items", query: [.init(name: "secret", value: "false")]), Endpoint(path: "/vault"),
            .versions("i1"), .version("v1"), .shares, .itemFile("i1"), .status, .whoami,
            try .proposeEdit(rootId: "r1", instruction: "x"), try .check("i1", true), Endpoint(method: "POST", path: "/items"),
        ]
        #expect(cacheable.filter { !ResponseCache.isCacheable($0) }.map(\.path) == [])
        #expect(refused.filter(ResponseCache.isCacheable).map(\.path) == [])

        let cache = ResponseCache(root: TestDirectory.make("cache"), baseURL: URL(string: "http://h:1")!, token: "em_a")
        for endpoint in refused { cache.store(Data("{}".utf8), for: endpoint) }
        #expect(!FileManager.default.fileExists(atPath: cache.directory.path))
        #expect(cache.load(.secretItems()) == nil)
    }

    @Test func savedAnswersArePerServerAndTokenAndSurviveRelaunch() throws {
        let root = TestDirectory.make("cache")
        let home = URL(string: "http://192.168.1.20:49231")!
        let a = ResponseCache(root: root, baseURL: home, token: "em_a")
        let otherToken = ResponseCache(root: root, baseURL: home, token: "em_b")
        let otherServer = ResponseCache(root: root, baseURL: URL(string: "http://100.64.0.2:49231")!, token: "em_a")
        #expect(Set([a.directory, otherToken.directory, otherServer.directory]).count == 3)
        #expect(!a.directory.path.contains("em_a") && !a.directory.path.contains("192.168"))

        let before = Date().addingTimeInterval(-2)
        let body = try Fixture.data("items")
        a.store(body, for: .items())
        a.store(Data("[]".utf8), for: .items(ItemFilter(shelf: .pinned)))

        let relaunched = try #require(ResponseCache(root: root, baseURL: home, token: "em_a").load(.items()))
        let decoder = JSONCoding.makeDecoder()
        #expect(try decoder.decode([Item].self, from: relaunched.data) == decoder.decode([Item].self, from: body))
        #expect(relaunched.savedAt >= before && relaunched.savedAt <= Date().addingTimeInterval(2))
        #expect(a.load(.items(ItemFilter(shelf: .pinned)))?.data == Data("[]".utf8))
        #expect(a.load(.items(ItemFilter(shelf: .reminders))) == nil)
        #expect(otherToken.load(.items()) == nil && otherServer.load(.items()) == nil)

        ResponseCache.removeAll(root: root)
        #expect(a.load(.items()) == nil)
        #expect(!FileManager.default.fileExists(atPath: root.path))
    }

    @Test func savedAnswersLoseCiphertextAndAIOutput() throws {
        let cache = ResponseCache(root: TestDirectory.make("cache"), baseURL: URL(string: "http://h:1")!, token: "em_a")
        let secret = itemJSON(id: "s1", title: "Secret note", metadata: #"{"secret":true,"vault":{"v":1,"data":"CIPHERTEXT"},"presentation":{"review":true}}"#)
        let enriched = itemJSON(id: "i1", title: "Relay", metadata: #"{"ai":{"status":"done","summary":"MODEL SUMMARY"},"siteName":"example.com"}"#)
        cache.store(Data("[\(secret),\(enriched)]".utf8), for: .items())
        let saved = try #require(cache.load(.items()))
        let text = String(decoding: saved.data, as: UTF8.self)
        #expect(!text.contains("CIPHERTEXT") && !text.contains("MODEL SUMMARY"))
        let items = try JSONCoding.makeDecoder().decode([Item].self, from: saved.data)
        #expect(items[0].isSecret && items[0].presentation.review && items[1].metadata.siteName == "example.com")
    }
}

@Suite struct PendingEditsTests {
    @Test func overlaysQueuedEditsOnSavedCopies() async throws {
        let clock = TestClock()
        let outbox = Outbox(directory: TestDirectory.make("outbox"), now: { clock.advance(1); return clock.now })
        let a = "01920000-0000-7000-8000-00000000000a", b = "01920000-0000-7000-8000-00000000000b"
        let c = "01920000-0000-7000-8000-00000000000c", d = "01920000-0000-7000-8000-00000000000d"
        let e = "01920000-0000-7000-8000-00000000000e", parent = "01920000-0000-7000-8000-0000000000ff"
        let inside = "01920000-0000-7000-8000-000000000101"
        try await outbox.enqueue(.updateItem(a, ItemUpdate(title: "First", baseTitle: "Orig")), kind: .edit, title: "a")
        try await outbox.enqueue(.updateItem(a, ItemUpdate(body: "Body", baseBody: "")), kind: .edit, title: "a")
        try await outbox.enqueue(.updateItem(a, ItemUpdate(title: "Second", baseTitle: "First")), kind: .edit, title: "a")
        try await outbox.enqueue(.check(b, true), kind: .edit, title: "b")
        try await outbox.enqueue(.updatePresentation(c, .init(kind: .heading)), kind: .edit, title: "c")
        try await outbox.enqueue(.updatePresentation(c, .init(attention: .high, checked: true)), kind: .edit, title: "c")
        try await outbox.enqueue(.moveOutlineItem(d, parentId: parent, beforeId: nil), kind: .edit, title: "d")
        try await outbox.enqueue(.createOutlineNote(OutlineNoteRequest(id: inside, parentId: parent, title: "Inside")), kind: .note, title: "Inside")
        try await outbox.enqueue(.createOutlineNote(OutlineNoteRequest(id: nil, parentId: nil, body: "Top body")), kind: .note, title: "Top")
        try await outbox.enqueue(.insertReference(e, to: a, label: nil), kind: .edit, title: "e")
        var rejected = try await outbox.enqueue(.updateItem(b, ItemUpdate(title: "Refused", baseTitle: "x")), kind: .edit, title: "b")
        rejected.needsAttention = true

        let pending = PendingEdits(await outbox.entries().filter { $0.id != rejected.id } + [rejected])
        #expect(pending.titles == [a: "Second"])
        #expect(pending.bodies == [a: "Body"])
        #expect(pending.checked(b) == true && pending.checked(a) == nil)
        #expect(pending.created[inside]?.title == "Inside" && pending.created[inside]?.parentId == parent)
        #expect(pending.notes(under: parent).isEmpty)
        #expect(pending.notes(under: nil).map(\.title) == ["Top body"])
        #expect(pending.touched == [a, b, c, d, e, inside])
        #expect(pending.isPending(d) && !pending.isPending(parent))
        #expect(pending.queuedParent(of: d) == .some(parent) && pending.queuedParent(of: a) == nil)

        let item = try JSONCoding.makeDecoder().decode(Item.self, from: Data(itemJSON(id: c, metadata: #"{"presentation":{"review":true,"kind":"section"}}"#).utf8))
        let shown = pending.presentation(of: item)
        #expect(shown.kind == .heading && shown.attention == .high && shown.checked && shown.review)
        #expect(PendingEdits().presentation(of: item).kind == .section)
    }

    @Test func existingFixturesDecodeWithDefaultPresentation() throws {
        let decoder = JSONCoding.makeDecoder()
        let items = try decoder.decode([Item].self, from: Fixture.data("items")) + decoder.decode([Item].self, from: Fixture.data("tasks"))
        #expect(items.allSatisfy { !$0.isSecret && $0.metadata.vault == nil && $0.presentation == ItemPresentation() })
        #expect(items.filter { $0.task == nil }.allSatisfy { !$0.isChecked })
    }
}
