import XCTest

/// Native workflow journey against the disposable paired server.
final class WorkflowsUITests: MemoryUITestCase {
    func testTemplateAndSavedViewJourney() async throws {
        let server = try await launchPaired()
        // Digits only: autocorrect leaves them alone, and the saved view searches for them.
        let marker = String(Int.random(in: 10_000_000...99_999_999))
        let source = "Workflow source \(marker)"
        let templateName = "Workflow template \(marker)"
        let copyTitle = "Workflow copy \(marker)"
        let viewName = "Workflow view \(marker)"
        let renamed = "\(viewName) renamed"

        try openLibraryTool("OpenOutline")
        let composer = element("OutlineComposer")
        try reveal(composer, "The outline has no composer.")
        composer.tap()
        app.typeText(source)
        app.buttons["Add note"].tap()
        let created = try await eventually("the source note on the server") { try await server.topLevelNote(titled: source) }
        let sourceID = try XCTUnwrap(created["id"] as? String)

        // Recent items on Home, newest first, open it once the server has it.
        try waitForToastToClear()
        app.buttons["Dock_home"].tap()
        let sourceRow = row(source)
        if !sourceRow.waitForExistence(timeout: 3) { app.swipeDown() }
        try reveal(sourceRow, "“\(source)” isn't in Recent.")
        sourceRow.tap()
        try require(app.staticTexts[source], "The source note didn't open.")
        try waitForToastToClear()
        try require(element("ItemMenu"), "The note has no actions menu.").tap()
        try require(app.buttons["Save as template…"], "The note's actions have no Save as template.").tap()
        let nameField = try require(element("TemplateName"), "The Save as template sheet has no name field.")
        nameField.tap()
        app.typeText(templateName)
        snapshot("Save as template")
        app.buttons["TemplateSave"].tap()
        try waitUntil(nameField, NSPredicate(format: "exists == false"), "The template sheet didn't close after saving.")

        let template = try await eventually("the template on the server") {
            try await server.list("/templates").first { $0["title"] as? String == templateName }
        }
        let templateID = try XCTUnwrap(template["id"] as? String)
        XCTAssertNotEqual(templateID, sourceID, "The template isn't a copy.")
        let original = try await server.item(sourceID)
        XCTAssertEqual(original["title"] as? String, source, "Saving a template renamed the source note.")
        XCTAssertNil((original["metadata"] as? [String: Any])?["template"], "Saving a template marked the source note.")

        try waitForToastToClear()
        app.buttons["Dock_home"].tap()
        try openLibraryTool("OpenTemplates")
        let templateRow = row(templateName)
        try reveal(templateRow, "“\(templateName)” isn't in the template library.")
        snapshot("Template library")
        templateRow.tap()
        let titleField = try require(element("TemplateUseTitle"), "The Use template sheet has no title field.")
        titleField.tap()
        app.typeText(copyTitle)
        let create = app.buttons["TemplateUseCreate"]
        try waitUntil(create, NSPredicate(format: "enabled == true"), "Create stayed disabled while connected.")
        create.tap()
        try require(app.staticTexts[copyTitle], "Using the template didn't open the new note.")
        snapshot("Note made from a template")

        let copy = try await eventually("the copy on the server") {
            try await server.list("/items", [URLQueryItem(name: "limit", value: "50")]).first { $0["title"] as? String == copyTitle }
        }
        let copyID = try XCTUnwrap(copy["id"] as? String)
        XCTAssertNil((copy["metadata"] as? [String: Any])?["template"], "The copy is still marked as a template.")
        XCTAssertNil(copy["project"] as? [String: Any], "The copy didn't go to the Inbox.")

        try waitForToastToClear()
        app.buttons["Dock_home"].tap()
        try openLibraryTool("OpenSavedViews")
        let newView = try require(app.buttons["NewSavedView"], "Saved views has no New view button.")
        try waitUntil(newView, NSPredicate(format: "enabled == true"), "New view stayed disabled while connected.")
        newView.tap()
        try require(element("SavedViewName"), "The saved view form has no name field.").tap()
        app.typeText(viewName)
        element("SavedViewQuery").tap()
        app.typeText(marker)
        app.buttons["SavedViewSave"].tap()

        try require(row(copyTitle), "The new saved view doesn't show the copy.")
        try require(row(source), "The new saved view doesn't show the source note.")
        XCTAssertFalse(row(templateName).exists, "A template showed in a saved view's results.")
        XCTAssertFalse(row(viewName).exists, "The saved view's own definition showed in its results.")
        snapshot("Saved view results")

        let view = try await eventually("the saved view on the server") {
            try await server.list("/views").first { $0["name"] as? String == viewName }
        }
        let viewID = try XCTUnwrap(view["id"] as? String)
        XCTAssertEqual(view["query"] as? String, marker)
        let results = try await server.object("/views/\(viewID)/items")
        let ids = Set((results["items"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String })
        XCTAssertTrue(ids.isSuperset(of: [copyID, sourceID]), "The server's results miss the copy or the source.")
        XCTAssertFalse(ids.contains(templateID), "The server's results include the template.")

        try waitForToastToClear()
        try require(app.buttons["SavedViewMenu"], "The saved view has no actions menu.").tap()
        try require(app.buttons["Edit view"], "The saved view's actions have no Edit.").tap()
        let editName = try require(element("SavedViewName"), "The edit form has no name field.")
        editName.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        app.typeText(" renamed")
        app.buttons["SavedViewSave"].tap()
        _ = try await eventually("the rename on the server") {
            try await server.object("/views/\(viewID)")["name"] as? String == renamed ? true : nil
        }
        try require(app.staticTexts[renamed], "The results screen didn't show the new name.")

        try waitForToastToClear()
        app.buttons["SavedViewMenu"].tap()
        try require(app.buttons["Remove view"], "The saved view's actions have no Remove.").tap()
        try require(app.staticTexts["Remove “\(renamed)”?"], "Removing didn't ask for confirmation.")
        snapshot("Remove saved view confirmation")
        app.buttons["Remove view"].firstMatch.tap()
        try require(app.buttons["NewSavedView"], "Removing didn't return to the saved views list.")
        try waitUntil(row(renamed), NSPredicate(format: "exists == false"), "The removed view is still listed.")
        _ = try await eventually("the view to leave the server's list") {
            try await server.list("/views").contains { $0["id"] as? String == viewID } ? nil : true
        }
        let shown = try await server.item(copyID)
        XCTAssertTrue(shown["archivedAt"] is NSNull, "Removing the view archived an item it showed.")
    }

    /// Rows combine their texts into one label that starts with the title.
    private func row(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }
}
