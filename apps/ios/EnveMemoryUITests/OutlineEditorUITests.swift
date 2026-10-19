import XCTest

/// Adds a note from the outline, undoes and redoes it, then edits it in the shared formatted editor, checking each
/// step on the server.
final class OutlineEditorUITests: MemoryUITestCase {
    func testAddUndoRedoAndFormattedEdit() async throws {
        let server = try await launchPaired()
        // Digits only: autocorrect leaves them alone.
        let title = "Outline harness \(Int.random(in: 10_000_000...99_999_999))"
        let edited = "\(title) edited"
        let marker = String(Int.random(in: 10_000_000...99_999_999))

        try openLibraryTool("OpenOutline")
        let composer = element("OutlineComposer")
        try reveal(composer, "The outline has no composer.")
        composer.tap()
        app.typeText(title)
        app.buttons["Add note"].tap()

        let row = try showRow(title)
        snapshot("Outline with the new note")
        let created = try await eventually("the new note on the server") { try await server.topLevelNote(titled: title) }
        let id = try XCTUnwrap(created["id"] as? String)
        XCTAssertTrue(created["archivedAt"] is NSNull, "The new note arrived archived.")

        let undo = app.buttons["StructuralUndo"]
        try waitUntil(undo, NSPredicate(format: "enabled == true AND label CONTAINS %@", title), "Undo isn't offered for the new note.")
        try waitForToastToClear()
        undo.tap()
        try waitUntil(row, NSPredicate(format: "exists == false"), "Undo left the note in the outline.")
        _ = try await eventually("undo to archive the note") { try await server.item(id)["archivedAt"] is String ? true : nil }

        let redo = app.buttons["StructuralRedo"]
        try waitUntil(redo, NSPredicate(format: "enabled == true AND label CONTAINS %@", title), "Redo isn't offered after undo.")
        try waitForToastToClear()
        redo.tap()
        let restored = try showRow(title)
        _ = try await eventually("redo to restore the note") { try await server.item(id)["archivedAt"] is NSNull ? true : nil }
        try waitForToastToClear()
        restored.tap()
        try require(app.buttons["Edit"], "The note's actions have no Edit.").tap()
        let titleField = try require(element("EditorTitle"), "The editor has no title field.")
        titleField.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        app.typeText(" edited")
        XCTAssertEqual(titleField.value as? String, edited)

        let editor = app.webViews.firstMatch
        try require(editor, "The shared formatted editor isn't bundled; run scripts/build-editor.sh before building.")
        let bold = try require(editor.switches["Bold"], "The formatted editor's toolbar didn't render.")
        try require(webField("Text", in: editor), "The formatted editor's text surface didn't render.").tap()
        app.typeText("Plain ")
        bold.tap()
        app.typeText(marker)
        snapshot("Formatted editor")

        editor.switches["Edit as Markdown"].tap()
        let source = try require(webField("Text (Markdown)", in: editor), "The editor's Markdown view didn't open.")
        try waitUntil(source, NSPredicate(format: "value CONTAINS %@", "Plain **\(marker)**"), "Bold from the toolbar didn't reach the Markdown.")
        snapshot("Formatted editor as Markdown")

        let save = app.navigationBars["Edit"].buttons["Save"]
        try waitUntil(save, NSPredicate(format: "enabled == true"), "Save stayed disabled.")
        save.tap()
        try waitUntil(editor, NSPredicate(format: "exists == false"), "The editor didn't close after saving.")
        _ = try await eventually("the edit on the server") {
            let item = try await server.item(id)
            return item["title"] as? String == edited && (item["body"] as? String)?.contains("**\(marker)**") == true ? true : nil
        }
        try showRow(edited)
        snapshot("Outline after the edit")
    }

    /// The row's action menu, paging in "Show more" when the top level is longer than one page.
    @discardableResult
    private func showRow(_ title: String) throws -> XCUIElement {
        let label = "Actions for \(title)"
        let actions = app.buttons[label]
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Show more (")).firstMatch
        let either = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", label, "Show more (")).firstMatch
        for _ in 0..<20 {
            try require(either, "“\(title)” isn't in the outline.")
            guard !actions.exists, more.exists else { break }
            more.tap()
        }
        try reveal(actions, "“\(title)” isn't in the outline.")
        return actions
    }

    /// Web content exposes the editor surface and the Markdown textarea as text views or text fields.
    private func webField(_ label: String, in webView: XCUIElement) -> XCUIElement {
        let types = [XCUIElement.ElementType.textView, .textField].map(\.rawValue)
        return webView.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType IN %@", label, types)).firstMatch
    }
}
