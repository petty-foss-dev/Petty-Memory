import XCTest

/// AI chat against the disposable paired server, whose AI must be a deterministic fixture, never a real model or library.
/// The microphone is never tapped: dictation needs a device, so only its controls and disclosure are checked.
final class ChatUITests: MemoryUITestCase {
    /// The fixture answers a question with text and proposes at least one change to a chosen note.
    func testAskThenReviewApplyAndUndoAProposal() async throws {
        _ = try Fixture.required("MEMORY_AI_FIXTURE", for: "AI chat against a deterministic AI fixture")
        let server = try await launchPaired()
        let status = try await server.object("/ai/status")
        guard status["configured"] as? Bool == true, let label = status["label"] as? String else {
            throw FixtureError("The scratch server has no AI fixture configured.")
        }
        // Digits only: autocorrect leaves them alone, and search finds them.
        let marker = String(Int.random(in: 10_000_000...99_999_999))
        let title = "Chat source \(marker)"

        try require(element("OpenOutline"), "Home has no Outline shortcut.").tap()
        let composer = element("OutlineComposer")
        try reveal(composer, "The outline has no composer.")
        composer.tap()
        app.typeText(title)
        app.buttons["Add note"].tap()
        let created = try await eventually("the source note on the server") { try await server.topLevelNote(titled: title) }
        let rootID = try XCTUnwrap(created["id"] as? String)
        let original = try await server.subtree(rootID)

        try waitForToastToClear()
        app.buttons["Dock_home"].tap()
        try require(element("OpenAIChat"), "Home has no AI chat shortcut.").tap()
        try waitUntil(element("AIProviderDisclosure"), NSPredicate(format: "label CONTAINS %@", label), "Chat didn't say which AI answers.")
        try require(element("DictationDisclosure"), "Chat doesn't say where dictated speech goes.")
        try require(element("ChatDictate"), "Chat has no Dictate button.")

        let question = "What does chat source \(marker) say?"
        try require(element("ChatDraft"), "Chat has no message field.").tap()
        app.typeText(question)
        app.buttons["ChatSend"].tap()
        try require(element("ChatAnswer"), "Asking didn't show an answer.")
        try require(element("ChatQuestion"), "The question isn't shown in the conversation.")
        XCTAssertFalse((element("ChatDraft").value as? String ?? "").contains(marker), "The sent message stayed in the draft.")
        snapshot("AI chat answer")

        let source = app.buttons.matching(identifier: "ChatSource").firstMatch
        try reveal(source, "The answer has no source to open.")
        source.tap()
        try require(app.staticTexts[title], "The cited source didn't open.")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        try require(element("ChatAnswer"), "Coming back from a source lost the conversation.")

        app.segmentedControls["ChatMode"].buttons["Change notes"].tap()
        try require(element("ChatStartedOver"), "Switching to changing notes didn't start a new conversation.")
        XCTAssertFalse(element("ChatAnswer").exists, "The question-and-answer context carried into changing notes.")
        XCTAssertFalse(app.buttons["ChatSend"].isEnabled, "Change notes could be sent without choosing notes.")

        try require(element("ChatScope"), "Change notes has no way to choose notes.").tap()
        let search = try require(app.searchFields.firstMatch, "The note picker has no search field.")
        search.tap()
        app.typeText(marker)
        try require(app.buttons[title], "The note picker didn't find “\(title)”.").tap()
        try waitUntil(element("ChatScope"), NSPredicate(format: "label CONTAINS %@", title), "The chosen notes aren't shown.")

        try require(app.buttons["Turn into checklist"], "Change notes has no quick starters.").tap()
        app.buttons["ChatSend"].tap()
        let review = app.buttons["ChatReview"]
        try reveal(review, "Changing notes didn't offer a proposal to review.")
        let unapplied = try await server.subtree(rootID)
        XCTAssertEqual(unapplied, original, "A proposal changed notes before it was reviewed.")
        snapshot("AI chat proposal")

        review.tap()
        let apply = try require(app.buttons["AIApply"], "Review has no Apply button.")
        try waitUntil(apply, NSPredicate(format: "enabled == true"), "Apply stayed disabled for the chat's proposal.")
        XCTAssertFalse(element("AIInstruction").exists, "Reviewing a chat proposal offered to ask the AI again.")
        snapshot("AI chat proposal review")
        apply.tap()
        let undo = try require(app.buttons["AIUndo"], "Applying didn't offer Undo.")
        _ = try await eventually("the applied changes on the server") {
            try await server.subtree(rootID) == original ? nil : true
        }
        undo.tap()
        _ = try await eventually("the undo on the server") {
            try await server.subtree(rootID) == original ? true : nil
        }
        try require(element("ChatProposal"), "Closing review lost the conversation.")

        try waitForToastToClear()
        app.buttons["ChatNew"].tap()
        try require(app.buttons.matching(identifier: "ChatNewConfirm").firstMatch, "New chat didn't ask first.").tap()
        try waitUntil(element("ChatProposal"), NSPredicate(format: "exists == false"), "New chat kept the old conversation.")
        try require(element("ChatStartedOver"), "New chat didn't say applied changes stay.")
    }

    /// The fixture's planner must take the topic and destination from “Organize all notes about <topic> into <name>.”
    /// and place every note it is given.
    func testOrganizeLibraryReviewSubsetOpenAndUndo() async throws {
        _ = try Fixture.required("MEMORY_AI_FIXTURE", for: "library organization against a deterministic AI fixture")
        let server = try await launchPaired()
        let marker = String(Int.random(in: 10_000_000...99_999_999))
        let kept = "Organize first \(marker)"
        let excluded = "Organize second \(marker)"
        let destination = "Garden \(marker)"

        try require(element("OpenOutline"), "Home has no Outline shortcut.").tap()
        let composer = element("OutlineComposer")
        for title in [kept, excluded] {
            try reveal(composer, "The outline has no composer.")
            composer.tap()
            app.typeText(title)
            app.buttons["Add note"].tap()
            _ = try await eventually("“\(title)” on the server") { try await server.topLevelNote(titled: title) }
            try waitForToastToClear()
        }

        app.buttons["Dock_home"].tap()
        try require(element("OpenAIChat"), "Home has no AI chat shortcut.").tap()
        app.segmentedControls["ChatMode"].buttons["Organize"].tap()
        try require(element("ChatOrganizeHelp"), "Organize doesn't explain what it does.")
        XCTAssertFalse(element("ChatScope").exists, "Organize asked for a branch to be chosen first.")
        try require(element("ChatDictate"), "Organize has no Dictate button.")
        element("ChatDraft").tap()
        app.typeText("Organize all notes about \(marker) into \(destination).")
        app.buttons["ChatSend"].tap()

        let review = app.buttons["ChatReviewOrganization"]
        try reveal(review, "Organize didn't offer a proposal to review.")
        let untouched = try await server.topLevelNote(titled: kept)
        XCTAssertNotNil(untouched, "A proposal moved a note before it was reviewed.")
        let early = try await server.topLevelNote(titled: destination)
        XCTAssertNil(early, "A proposal created its destination before it was reviewed.")
        snapshot("Organize proposal in chat")

        review.tap()
        try waitUntil(element("OrganizationCounts"), NSPredicate(format: "label BEGINSWITH %@", "2 notes match"), "The review doesn't count the matching notes.")
        try waitUntil(element("OrganizationDestination"), NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", destination, "New top-level note"),
                      "The review doesn't name the new destination.")
        let out = app.switches.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "OrganizationCandidate", excluded)).firstMatch
        try reveal(out, "“\(excluded)” isn't listed for review.")
        XCTAssertEqual(out.value as? String, "1", "Candidates aren't selected by default.")
        out.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        try waitUntil(out, NSPredicate(format: "value == %@", "0"), "Unticking a candidate didn't take.")
        let apply = app.buttons["OrganizationApply"]
        try waitUntil(apply, NSPredicate(format: "label == %@", "Move 1"), "Apply doesn't reflect the selection.")
        snapshot("Organize review")
        apply.tap()

        try require(app.buttons["OrganizationUndo"], "Applying didn't offer Undo.")
        _ = try await eventually("the selected note to move") { try await server.topLevelNote(titled: kept) == nil ? true : nil }
        let root = try await eventually("the destination") { try await server.topLevelNote(titled: destination) }
        let stayed = try await server.topLevelNote(titled: excluded)
        XCTAssertNotNil(stayed, "An unticked note moved.")

        try waitForToastToClear()
        app.buttons["OrganizationOpen"].tap()
        try require(app.staticTexts[destination], "Opening the result didn't show the destination's outline.")
        snapshot("Organized outline")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let reopen = app.buttons["ChatReviewOrganization"]
        try reveal(reopen, "The chat lost the organization.")
        reopen.tap()
        try require(app.buttons["OrganizationUndo"], "Reopening the review lost Undo.").tap()
        _ = try await eventually("the note back at the top level") { try await server.topLevelNote(titled: kept) == nil ? nil : true }
        let rootID = try XCTUnwrap(root["id"] as? String)
        _ = try await eventually("the destination archived") { try await server.item(rootID)["archivedAt"] is NSNull ? nil : true }
    }
}

private extension ScratchServer {
    /// Titles, text and presentation of a note and everything inside it, in a fixed order; archived notes left out.
    func subtree(_ id: String) async throws -> [String] {
        let root = try await item(id)
        var lines = [Self.line(root, depth: 0)]
        var pending: [(String, Int)] = [(id, 1)]
        while let next = pending.popLast(), lines.count < 200 {
            let (parent, depth) = next
            let page = try await object("/outline", [URLQueryItem(name: "parent", value: parent), URLQueryItem(name: "limit", value: "100")])
            for entry in (page["items"] as? [[String: Any]] ?? []) {
                guard let child = entry["item"] as? [String: Any], let childID = child["id"] as? String else { continue }
                lines.append(Self.line(child, depth: depth))
                pending.append((childID, depth + 1))
            }
        }
        return lines
    }

    /// Default presentation values are dropped: an undo may write them back explicitly where they were absent.
    private static func line(_ item: [String: Any], depth: Int) -> String {
        let presentation = ((item["metadata"] as? [String: Any])?["presentation"] as? [String: Any] ?? [:])
            .filter { _, value in !(value as? Bool == false || ["text", "normal"].contains(value as? String)) }
        let shown = (try? JSONSerialization.data(withJSONObject: presentation, options: .sortedKeys))
            .map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return "\(depth) \(item["id"] ?? "") \(item["title"] ?? "") \(item["body"] ?? "") \(shown)"
    }
}
