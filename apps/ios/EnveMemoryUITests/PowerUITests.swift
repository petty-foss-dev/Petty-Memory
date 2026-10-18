import XCTest

/// Saved chats, reviewed actions, daily review, duplicate merging and image text against the disposable paired server.
/// Needs the power fixture's seeded notes; the AI journeys also need its deterministic AI, never a real model or library.
final class PowerUITests: MemoryUITestCase {
    private let meetingTitle = "Garden meeting"
    private let duplicateTitle = "Duplicate garden plan"
    private let imageTitle = "OCR field card"
    private let imageText = "MEMORY KEEPS IDEAS"

    /// Seed the first document in Files' Recents with the highlight fixture and ocr-note.png as the newest photo.
    func testNativePhotoRecognitionAndHighlightFileImport() async throws {
        _ = try Fixture.required("MEMORY_NATIVE_CAPTURE_FIXTURE", for: "the simulator's seeded Files and Photos")
        let server = try await launchPaired()
        app.buttons["Dock_settings"].tap()
        let importer = app.buttons["SettingsEnveImport"]
        try reveal(importer, "Settings has no Enve import.")
        importer.tap()
        try require(app.buttons["EnveImportChoose"], "Import has no file picker.").tap()
        try waitUntil(app.buttons["EnveImportChoose"], NSPredicate(format: "hittable == false"), "The system export picker didn't open.")
        captureScreen("System export picker")
        // iOS 27 system pickers render in a remote process; these fixture tiles were verified on the dedicated Air.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.28)).tap()
        captureScreen("Selected export")
        try require(element("EnveImportCounts"), "The export wasn't previewed.")
        snapshot("Enve highlights preview")
        try require(app.buttons["EnveImportRun"], "The preview has no Import action.").tap()
        try require(element("EnveImportResult"), "Import didn't show its result.")
        let imported = try await server.seededItem(titled: "Native Fictional Garden · 25%")
        XCTAssertTrue((imported["body"] as? String ?? "").contains("Plant tomatoes after the final frost."))
        XCTAssertTrue((imported["tags"] as? [String] ?? []).contains("highlights"))

        try waitForToastToClear()
        app.buttons["Dock_home"].tap()
        try require(app.buttons["New image"], "Home has no image capture.").tap()
        try require(app.buttons["ImageFromPhotos"], "Image capture has no Photos picker.").tap()
        try waitUntil(app.buttons["ImageFromPhotos"], NSPredicate(format: "hittable == false"), "The system Photos picker didn't open.")
        // Photos' remote picker doesn't expose cells to the runtime snapshot; the seeded newest photo is the first tile.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.43)).tap()
        let extract = app.buttons["ImageExtractText"]
        try require(extract, "The chosen photo didn't load.").tap()
        let draft = element("ImageTextDraft")
        try waitUntil(draft, NSPredicate(format: "value CONTAINS %@", imageText), "Vision didn't recognize the fixture's text.")
        snapshot("On-device image text")
        let save = app.buttons["CaptureSave"]
        try waitUntil(save, NSPredicate(format: "enabled == true"), "The reviewed image can't be saved.")
        save.tap()
        _ = try await eventually("the image and recognized text on the host") {
            try await server.list("/items", [URLQueryItem(name: "type", value: "image"), URLQueryItem(name: "limit", value: "100")])
                .first { ($0["body"] as? String ?? "").contains(self.imageText) }
        }
    }

    /// The fixture answers with the cited note's own text.
    func testAskSaveReopenAndContinueSavedChat() async throws {
        _ = try Fixture.required("MEMORY_AI_FIXTURE", for: "saved chats against a deterministic AI fixture")
        _ = try Fixture.required("MEMORY_POWER_FIXTURE", for: "saved chats against the seeded power fixture")
        let server = try await launchPaired()
        _ = try await server.seededItem(titled: meetingTitle)
        // Digits only: autocorrect leaves them alone, and saved-chat search finds them.
        let marker = String(Int.random(in: 10_000_000...99_999_999))
        let title = "Saved chat \(marker)"
        let first = "What did the garden meeting agree?"
        let second = "What should we buy for the garden?"

        try require(element("OpenAIChat"), "Home has no AI chat shortcut.").tap()
        try send(first)
        let answer = try require(element("ChatAnswer"), "Asking didn't show an answer.")
        let said = answer.label
        XCTAssertTrue(said.localizedCaseInsensitiveContains("raised beds"), "The answer doesn't quote the cited note.")
        try require(app.buttons.matching(identifier: "ChatSource").firstMatch, "The answer cites no source.")
        XCTAssertFalse(element("ChatSavedNote").exists, "An unsaved chat claims to be saved.")

        try waitForToastToClear()
        app.buttons["ChatSave"].tap()
        try nameSavedChat(title)
        let stored = try await eventually("the saved chat on the server") {
            try await server.list("/conversations").first { $0["title"] as? String == title }
        }
        let id = try XCTUnwrap(stored["id"] as? String)
        let saved = try await server.object("/conversations/\(id)")
        XCTAssertEqual(saved["mode"] as? String, "ask")
        XCTAssertEqual(Self.contents(saved), [first, said], "The saved chat isn't the exchange that was shown.")
        try waitUntil(element("ChatSavedNote"), NSPredicate(format: "label CONTAINS %@", title), "Chat doesn't say it was saved.")

        try waitForToastToClear()
        app.buttons["Dock_home"].tap()
        try require(element("OpenSavedChats"), "Home has no Saved chats shortcut.").tap()
        try require(app.searchFields.firstMatch, "Saved chats has no search field.").tap()
        app.typeText(marker)
        let row = savedChatRow(title)
        try require(row, "Searching saved chats didn't find “\(title)”.")
        snapshot("Saved chats search")
        row.tap()
        try waitUntil(element("ChatAnswer"), NSPredicate(format: "label == %@", said), "Reopening didn't bring the answer back.")
        try require(element("ChatQuestion"), "Reopening didn't bring the question back.")
        try waitUntil(element("ChatSavedNote"), NSPredicate(format: "label CONTAINS %@", title), "The reopened chat doesn't name its saved copy.")
        snapshot("Saved chat reopened")

        try send(second)
        let answers = app.descendants(matching: .any).matching(identifier: "ChatAnswer")
        try require(answers.element(boundBy: 1), "Continuing the saved chat didn't answer.")
        try waitUntil(element("ChatSavedNote"), NSPredicate(format: "label CONTAINS %@", "aren't saved yet"), "Chat doesn't say newer messages are unsaved.")
        let reply = answers.element(boundBy: 1).label

        try waitForToastToClear()
        app.buttons["ChatSave"].tap()
        try require(app.alerts["Update saved conversation"], "Saving again didn't offer to update the saved chat.")
        app.alerts.buttons["Save"].tap()
        let updated = try await eventually("the update on the server") {
            let conversation = try await server.object("/conversations/\(id)")
            return Self.contents(conversation).count == 4 ? conversation : nil
        }
        XCTAssertEqual(Self.contents(updated), [first, said, second, reply], "The update isn't the whole conversation.")
        let matches = try await server.list("/conversations").filter { $0["title"] as? String == title }
        XCTAssertEqual(matches.compactMap { $0["id"] as? String }, [id], "Saving again made a second conversation.")
    }

    /// The fixture proposes four actions from the chosen note: task, tag, reminder and brief.
    func testActionsApplySelectedUndoAndSaveSummaryOnly() async throws {
        _ = try Fixture.required("MEMORY_AI_FIXTURE", for: "AI actions against a deterministic AI fixture")
        _ = try Fixture.required("MEMORY_POWER_FIXTURE", for: "AI actions against the seeded power fixture")
        let server = try await launchPaired()
        let meeting = try await server.seededItem(titled: meetingTitle)
        let meetingID = try XCTUnwrap(meeting["id"] as? String)
        let body = meeting["body"] as? String
        let tags = Set(meeting["tags"] as? [String] ?? [])
        let reminder = meeting["remindAt"] as? String
        guard !tags.contains("gardening") else { throw FixtureError("“\(meetingTitle)” is already tagged gardening, so the tag can't be checked.") }
        let marker = String(Int.random(in: 10_000_000...99_999_999))
        let title = "Actions chat \(marker)"

        try require(element("OpenAIChat"), "Home has no AI chat shortcut.").tap()
        app.segmentedControls["ChatMode"].buttons["Actions"].tap()
        try require(element("ChatActionsHelp"), "Actions doesn't explain what it does.")
        try require(element("ChatScope"), "Actions has no way to choose notes.").tap()
        try require(app.searchFields.firstMatch, "The note picker has no search field.").tap()
        app.typeText(meetingTitle)
        try require(app.buttons[meetingTitle], "The note picker didn't find “\(meetingTitle)”.").tap()
        try waitUntil(element("ChatScope"), NSPredicate(format: "label CONTAINS %@", meetingTitle), "The chosen note isn't shown.")
        try require(app.buttons["Tasks for open loops"], "Actions has no quick starters.").tap()
        try waitUntil(app.buttons["ChatSend"], NSPredicate(format: "enabled == true"), "Send stayed disabled with a note chosen.")
        app.buttons["ChatSend"].tap()

        let review = app.buttons["ChatReviewActions"]
        try reveal(review, "Actions didn't offer a proposal to review.")
        try await assertUnchanged(server, meetingID, body: body, tags: tags, reminder: reminder, "A proposal changed the note before review.")
        snapshot("Actions proposal in chat")

        review.tap()
        let operations = app.switches.matching(identifier: "ActionOperation")
        try require(operations.firstMatch, "Review lists no actions.")
        XCTAssertEqual(operations.count, 4, "Review doesn't list the task, tag, reminder and brief.")
        let brief = app.switches.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "ActionOperation", "Garden brief")).firstMatch
        try reveal(brief, "The brief isn't listed for review.")
        XCTAssertEqual(brief.value as? String, "1", "Actions aren't selected by default.")
        brief.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        try waitUntil(brief, NSPredicate(format: "value == %@", "0"), "Unticking the brief didn't take.")
        let apply = app.buttons["ActionsApply"]
        try waitUntil(apply, NSPredicate(format: "label == %@ AND enabled == true", "Apply 3"), "Apply doesn't reflect the selection.")
        try await assertUnchanged(server, meetingID, body: body, tags: tags, reminder: reminder, "Reviewing changed the note.")
        snapshot("Actions review")
        apply.tap()

        let undo = try require(app.buttons["ActionsUndo"], "Applying didn't offer Undo.")
        let task = try await eventually("the task on the server") {
            try await server.list("/items", [URLQueryItem(name: "type", value: "task"), URLQueryItem(name: "limit", value: "50")])
                .first { $0["title"] as? String == "Build raised beds" }
        }
        let taskID = try XCTUnwrap(task["id"] as? String)
        let applied = try await server.item(meetingID)
        XCTAssertEqual(Set(applied["tags"] as? [String] ?? []), tags.union(["gardening"]), "The tag wasn't added.")
        XCTAssertEqual(Self.timestamp(applied["remindAt"]), Self.timestamp("2026-12-20T12:00:00Z"), "The reminder wasn't set.")
        XCTAssertEqual(applied["body"] as? String, body, "Applying actions rewrote the note.")
        let notes = try await server.list("/items", [URLQueryItem(name: "type", value: "note"), URLQueryItem(name: "limit", value: "50")])
        XCTAssertFalse(notes.contains { $0["title"] as? String == "Garden brief" }, "The unticked brief was created.")
        snapshot("Actions applied")

        try waitForToastToClear()
        undo.tap()
        try waitUntil(undo, NSPredicate(format: "exists == false"), "Undo didn't close the review.")
        _ = try await eventually("the task archived") { try await server.item(taskID)["archivedAt"] is NSNull ? nil : true }
        try await assertUnchanged(server, meetingID, body: body, tags: tags, reminder: reminder, "Undo didn't put the note back.")
        try require(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Undone.")).firstMatch, "The chat doesn't say the actions were undone.")

        try waitForToastToClear()
        app.buttons["ChatSave"].tap()
        try nameSavedChat(title)
        let stored = try await eventually("the saved chat on the server") {
            try await server.list("/conversations").first { $0["title"] as? String == title }
        }
        let id = try XCTUnwrap(stored["id"] as? String)
        let saved = try await server.object("/conversations/\(id)")
        XCTAssertEqual(saved["mode"] as? String, "actions")
        XCTAssertEqual(saved["rootId"] as? String, meetingID, "The saved chat lost the chosen note.")
        let summary = try XCTUnwrap(Self.contents(saved).last)
        XCTAssertTrue(summary.hasPrefix("Proposed 4 actions for review."), "The proposal wasn't saved as its summary.")
        XCTAssertFalse(summary.contains("baseHash") || summary.contains("\"kind\""), "The saved chat kept the proposal itself.")

        try waitForToastToClear()
        app.buttons["ChatSavedList"].tap()
        try require(app.searchFields.firstMatch, "Saved chats has no search field.").tap()
        app.typeText(marker)
        try require(savedChatRow(title), "Saved chats didn't list “\(title)”.").tap()
        try waitUntil(element("ChatAnswer"), NSPredicate(format: "label BEGINSWITH %@", "Proposed 4 actions"), "The reopened proposal isn't its summary.")
        XCTAssertFalse(app.buttons["ChatReviewActions"].exists, "A saved proposal can be reviewed again.")
        snapshot("Saved actions chat")
    }

    /// No AI: reschedules review cards, merges the seeded duplicate and undoes it, then saves an image's text as a note.
    func testReviewMergeAndImageText() async throws {
        _ = try Fixture.required("MEMORY_POWER_FIXTURE", for: "review, merging and image text against the seeded power fixture")
        let server = try await launchPaired()

        try require(element("OpenReview"), "Home has no Daily review shortcut.").tap()
        let firstID = try await scheduleFirstReviewCard(server, chip: "ReviewIn1", days: 1, open: true)
        try waitForToastToClear()
        let secondID = try await scheduleFirstReviewCard(server, chip: "ReviewIn7", days: 7, open: false)
        XCTAssertNotEqual(firstID, secondID, "The scheduled card stayed first in review.")

        let meeting = try await server.seededItem(titled: meetingTitle)
        let duplicate = try await server.seededItem(titled: duplicateTitle)
        let meetingID = try XCTUnwrap(meeting["id"] as? String)
        let duplicateID = try XCTUnwrap(duplicate["id"] as? String)
        let meetingBody = (meeting["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let duplicateBody = (duplicate["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        try waitForToastToClear()
        try openFromSearch(meetingTitle)
        let find = app.buttons["FindConnections"]
        try reveal(find, "“\(meetingTitle)” has no Find connections.")
        find.tap()
        let suggestion = app.descendants(matching: .any).matching(identifier: "SuggestedConnection")
            .containing(NSPredicate(format: "label BEGINSWITH %@", duplicateTitle))
            .containing(.button, identifier: "SuggestionMerge").firstMatch
        try reveal(suggestion, "“\(duplicateTitle)” isn't suggested as a duplicate.")
        snapshot("Suggested connections")
        suggestion.buttons["SuggestionMerge"].tap()
        try require(app.buttons["Merge it into this note…"], "Merge doesn't offer a direction.").tap()

        let preview = try require(element("MergePreview"), "Merging didn't preview the result.").label
        XCTAssertTrue(preview.contains(meetingBody) && preview.contains(duplicateBody), "The preview doesn't show both notes' text.")
        let unmerged = try await server.item(duplicateID)
        XCTAssertTrue(unmerged["archivedAt"] is NSNull, "Previewing archived the duplicate.")
        let confirm = app.buttons["MergeConfirm"]
        try waitUntil(confirm, NSPredicate(format: "enabled == true"), "Merge stayed disabled after the preview.")
        snapshot("Merge preview")
        confirm.tap()

        let undo = try require(app.buttons["MergeUndo"], "Merging didn't offer Undo.")
        _ = try await eventually("the duplicate archived") { try await server.item(duplicateID)["archivedAt"] is NSNull ? nil : true }
        let merged = try await server.item(meetingID)
        XCTAssertEqual(merged["body"] as? String, preview, "The merged note isn't what the preview showed.")
        snapshot("Merged")
        try waitForToastToClear()
        undo.tap()
        try waitUntil(undo, NSPredicate(format: "exists == false"), "Undo didn't close the merge.")
        _ = try await eventually("the duplicate restored") { try await server.item(duplicateID)["archivedAt"] is NSNull ? true : nil }
        let restored = try await server.item(meetingID)
        XCTAssertEqual(restored["title"] as? String, meetingTitle, "Undo didn't restore the title.")
        XCTAssertEqual(restored["body"] as? String, meeting["body"] as? String, "Undo didn't restore the text.")

        let image = try await server.seededItem(titled: imageTitle)
        let imageID = try XCTUnwrap(image["id"] as? String)
        let attachments = Self.attachmentKeys(image)
        XCTAssertFalse(attachments.isEmpty, "“\(imageTitle)” has no attachment.")
        let noteTitle = "Text from \(imageTitle)"
        let earlier = try await Set(Self.notes(server, titled: noteTitle).compactMap { $0["id"] as? String })

        try waitForToastToClear()
        try openFromSearch(imageTitle)
        let extract = app.buttons["AttachmentExtractText"]
        try reveal(extract, "The image has no Extract text button.")
        extract.tap()
        let text = try require(element("AttachmentText"), "Extracting didn't show the text.")
        try waitUntil(text, NSPredicate(format: "value CONTAINS %@", imageText), "The extracted text isn't the image's.")
        let unsaved = try await Self.notes(server, titled: noteTitle).contains { !earlier.contains($0["id"] as? String ?? "") }
        XCTAssertFalse(unsaved, "Extracting saved a note before Save was tapped.")
        snapshot("Extracted text")
        app.buttons["AttachmentTextSave"].tap()
        try waitUntil(text, NSPredicate(format: "exists == false"), "Saving didn't close the sheet.")

        let note = try await eventually("the saved text note") {
            try await Self.notes(server, titled: noteTitle).first { !earlier.contains($0["id"] as? String ?? "") }
        }
        let saved = note["body"] as? String ?? ""
        XCTAssertTrue(saved.contains(imageText), "The note doesn't hold the extracted text.")
        XCTAssertTrue(saved.contains("[[item:\(imageID)"), "The note doesn't link back to the image.")
        let after = try await server.item(imageID)
        XCTAssertEqual(Self.attachmentKeys(after), attachments, "Saving the text changed the image's attachment.")
        XCTAssertEqual(after["body"] as? String, image["body"] as? String, "Saving the text changed the image's item.")
    }

    // MARK: Steps

    private func captureScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func send(_ question: String) throws {
        try require(element("ChatDraft"), "Chat has no message field.").tap()
        app.typeText(question)
        let send = app.buttons["ChatSend"]
        try waitUntil(send, NSPredicate(format: "enabled == true"), "Send stayed disabled.")
        send.tap()
    }

    /// The alert suggests a title; replace it with one the server lookups can find.
    private func nameSavedChat(_ title: String) throws {
        let field = try require(app.alerts.textFields.firstMatch, "Saving didn't ask for a title.")
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let suggested = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: suggested.count) + title)
        app.alerts.buttons["Save"].tap()
    }

    private func savedChatRow(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "SavedChat", title)).firstMatch
    }

    /// Search keeps its stack across tabs, so a second tap returns it to its field.
    private func openFromSearch(_ title: String) throws {
        app.buttons["Dock_search"].tap()
        if !element("SearchField").waitForExistence(timeout: 3) { app.buttons["Dock_search"].tap() }
        let field = try require(element("SearchField"), "Search has no field.")
        if app.buttons["Clear search"].exists { app.buttons["Clear search"].tap() }
        field.tap()
        app.typeText(title)
        try require(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch, "Search didn't find “\(title)”.").tap()
        try require(app.staticTexts[title], "“\(title)” didn't open.")
    }

    /// Which card comes first isn't assumed: its title is matched against the server's own queue.
    private func scheduleFirstReviewCard(_ server: ScratchServer, chip: String, days: Int, open: Bool) async throws -> String {
        let card = app.descendants(matching: .any).matching(identifier: "ReviewCard").firstMatch
        try require(card, "Daily review shows nothing due.")
        let label = try require(card.buttons["ReviewOpen"], "The review card has no Open button.").label
        let queue = try await server.list("/review", [URLQueryItem(name: "limit", value: "20")]).compactMap { $0["item"] as? [String: Any] }
        let matches = queue.filter { ($0["title"] as? String).map { !$0.isEmpty && label.hasPrefix($0) } ?? false }
        let item = try XCTUnwrap(matches.max { ($0["title"] as? String ?? "").count < ($1["title"] as? String ?? "").count },
                                 "The first card isn't in the server's review queue.")
        let id = try XCTUnwrap(item["id"] as? String)
        let title = try XCTUnwrap(item["title"] as? String)
        let count = Self.reviewSchedule(item)?["count"] as? Int ?? 0

        if open {
            snapshot("Daily review")
            card.buttons["ReviewOpen"].tap()
            try require(app.staticTexts[title], "Opening the review card didn't show “\(title)”.")
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        let interval = card.buttons[chip]
        try reveal(interval, "The review card has no \(chip) choice.")
        let started = Date.now
        interval.tap()
        let shown = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "ReviewOpen", title)).firstMatch
        try waitUntil(shown, NSPredicate(format: "exists == false"), "“\(title)” stayed in review after scheduling.")

        let schedule = try await eventually("the review schedule of “\(title)”") {
            let current = try await server.item(id)
            let schedule = Self.reviewSchedule(current)
            return schedule?["count"] as? Int == count + 1 ? schedule : nil
        }
        XCTAssertEqual((schedule["history"] as? [[String: Any]])?.last?["days"] as? Int, days, "The review history doesn't record the interval.")
        let due = try XCTUnwrap(Self.timestamp(schedule["dueAt"]), "The review schedule has no due date.")
        XCTAssertEqual(due.timeIntervalSince(started), TimeInterval(days * 86_400), accuracy: 600, "“\(title)” isn't due again in \(days) days.")
        return id
    }

    private func assertUnchanged(_ server: ScratchServer, _ id: String, body: String?, tags: Set<String>, reminder: String?,
                                 _ message: String) async throws {
        let item = try await server.item(id)
        XCTAssertEqual(item["body"] as? String, body, message)
        XCTAssertEqual(Set(item["tags"] as? [String] ?? []), tags, message)
        XCTAssertEqual(Self.timestamp(item["remindAt"]), Self.timestamp(reminder), message)
    }

    // MARK: Reading the server

    private static func contents(_ conversation: [String: Any]) -> [String] {
        (conversation["messages"] as? [[String: Any]] ?? []).compactMap { $0["content"] as? String }
    }

    private static func reviewSchedule(_ item: [String: Any]) -> [String: Any]? {
        (item["metadata"] as? [String: Any])?["reviewSchedule"] as? [String: Any]
    }

    private static func attachmentKeys(_ item: [String: Any]) -> [String] {
        (item["attachments"] as? [[String: Any]] ?? []).map { "\($0["id"] ?? "") \($0["sha256"] ?? "")" }.sorted()
    }

    /// Newest first, so a note saved during the test is on the first page.
    private static func notes(_ server: ScratchServer, titled title: String) async throws -> [[String: Any]] {
        try await server.list("/items", [URLQueryItem(name: "type", value: "note"), URLQueryItem(name: "limit", value: "100")])
            .filter { $0["title"] as? String == title }
    }

    private static func timestamp(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

private extension ScratchServer {
    /// The power fixture's item with exactly this title, in full; it must still be active.
    func seededItem(titled title: String) async throws -> [String: Any] {
        let hits = try await list("/search", [URLQueryItem(name: "q", value: title), URLQueryItem(name: "limit", value: "20")])
        guard let id = hits.first(where: { $0["title"] as? String == title })?["id"] as? String else {
            throw FixtureError("The power fixture has no active item titled “\(title)”.")
        }
        return try await item(id)
    }
}
