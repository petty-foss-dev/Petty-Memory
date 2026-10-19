import XCTest

/// The Knowledge workspace against the seeded knowledge fixture and its deterministic AI, never a real model, provider or library.
/// The microphone is never started: the recorder is only opened and closed.
final class KnowledgeUITests: MemoryUITestCase {
    private let meetingTitle = "Garden meeting"

    /// The fixture's AI proposes a task “Order cedar boards”, a tag `garden-review` and a brief “Garden visit brief”.
    func testWorkflowRunReviewApplySelectedAndUndo() async throws {
        let server = try await launchKnowledge()
        try await requireAI(server)
        let meeting = try await server.knowledgeItem(titled: meetingTitle)
        let meetingID = try XCTUnwrap(meeting["id"] as? String)
        let body = meeting["body"] as? String
        let tags = Set(meeting["tags"] as? [String] ?? [])
        let earlierTasks = try await Self.ids(server, type: "task", titled: "Order cedar boards")
        let earlierBriefs = try await Self.ids(server, type: "note", titled: "Garden visit brief")
        let name = "Garden follow-ups \(Self.marker())"

        try openKnowledge("workflows")
        try require(workflowCard("Garden follow-ups"), "The seeded workflow isn't listed.")
        try require(app.buttons["NewWorkflow"], "Workflows has no New workflow button.").tap()
        try require(element("WorkflowName"), "The workflow form has no name field.").tap()
        app.typeText(name)
        element("WorkflowInstruction").tap()
        app.typeText("Suggest tasks for open questions and a short brief.")
        app.buttons["WorkflowBranch"].tap()
        try require(app.searchFields.firstMatch, "The branch picker has no search field.").tap()
        app.typeText(meetingTitle)
        try require(button(labeled: meetingTitle), "The branch picker didn't find “\(meetingTitle)”.").tap()
        try waitUntil(app.buttons["WorkflowBranch"], NSPredicate(format: "label CONTAINS %@", meetingTitle), "The chosen branch isn't shown.")
        let save = app.buttons["WorkflowSave"]
        try waitUntil(save, NSPredicate(format: "enabled == true"), "The workflow can't be saved.")
        save.tap()
        let recipe = try await eventually("the workflow on the server") {
            try await server.list("/knowledge/recipes").first { $0["name"] as? String == name }
        }
        let recipeID = try XCTUnwrap(recipe["id"] as? String)
        XCTAssertEqual((recipe["scope"] as? [String: Any])?["rootId"] as? String, meetingID, "The workflow isn't scoped to the chosen branch.")

        let card = workflowCard(name)
        let run = card.buttons["WorkflowRun"]
        try reveal(run, "The new workflow isn't listed with a Run button.")
        run.tap()
        let preference = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "PreferenceChoice", "Short task names")).firstMatch
        try require(preference, "The run doesn't offer the global preference “Short task names”.").tap()
        try waitUntil(preference, NSPredicate(format: "selected == true"), "Ticking the preference didn't take.")
        let confirm = app.buttons["WorkflowRunConfirm"]
        try waitUntil(confirm, NSPredicate(format: "enabled == true"), "The workflow can't be run.")
        snapshot("Workflow run")
        confirm.tap()

        let operations = app.switches.matching(identifier: "ActionOperation")
        try require(operations.firstMatch, "Running the workflow didn't open a review.")
        XCTAssertEqual(operations.count, 3, "Review doesn't list the task, tag and brief.")
        try await assertUnchanged(server, meetingID, body: body, tags: tags, "Running the workflow changed the note before review.")
        for heading in ["Tag ", "New note: Garden visit brief"] {
            let operation = app.switches.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "ActionOperation", heading)).firstMatch
            try reveal(operation, "“\(heading)” isn't listed for review.")
            XCTAssertEqual(operation.value as? String, "1", "Actions aren't selected by default.")
            operation.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            try waitUntil(operation, NSPredicate(format: "value == %@", "0"), "Unticking “\(heading)” didn't take.")
        }
        let apply = app.buttons["ActionsApply"]
        try waitUntil(apply, NSPredicate(format: "label == %@ AND enabled == true", "Apply 1"), "Apply doesn't reflect the selection.")
        snapshot("Workflow review")
        apply.tap()

        let undo = try require(app.buttons["ActionsUndo"], "Applying didn't offer Undo.")
        let task = try await eventually("the new task on the server") {
            try await server.list("/items", [URLQueryItem(name: "type", value: "task"), URLQueryItem(name: "limit", value: "100")])
                .first { $0["title"] as? String == "Order cedar boards" && !earlierTasks.contains($0["id"] as? String ?? "") }
        }
        let taskID = try XCTUnwrap(task["id"] as? String)
        try await assertUnchanged(server, meetingID, body: body, tags: tags, "The unticked tag was applied.")
        let briefs = try await Self.ids(server, type: "note", titled: "Garden visit brief")
        XCTAssertTrue(briefs.isSubset(of: earlierBriefs), "The unticked brief was created.")

        try waitForToastToClear()
        undo.tap()
        try waitUntil(undo, NSPredicate(format: "exists == false"), "Undo didn't close the review.")
        _ = try await eventually("the task archived") { try await server.item(taskID)["archivedAt"] is NSNull ? nil : true }
        try await assertUnchanged(server, meetingID, body: body, tags: tags, "Undo didn't leave the note as it was.")
        try require(app.staticTexts["Last run undone."], "The workflow doesn't say its run was undone.")

        try waitForToastToClear()
        let menu = card.buttons["WorkflowMenu"]
        try reveal(menu, "The new workflow has no actions menu.")
        menu.tap()
        try require(button(labeled: "Archive"), "The workflow menu has no Archive.").tap()
        try require(button(labeled: "Archive workflow"), "Archiving didn't ask first.").tap()
        _ = try await eventually("the workflow archived") {
            try await server.list("/knowledge/recipes").contains { $0["id"] as? String == recipeID } ? nil : true
        }
        try waitUntil(card, NSPredicate(format: "exists == false"), "The archived workflow is still listed.")
    }

    /// The fixture's AI flags the exact first quotes of the two “Cobalt supplier” notes (Tuesday and Friday deliveries).
    func testPreferenceCreationAndConflictDismissal() async throws {
        let server = try await launchKnowledge()
        try await requireAI(server)
        let name = "Garden receipts \(Self.marker())"
        let instruction = "File garden receipts under Garden, one heading per season."

        try openKnowledge("preferences")
        try require(app.staticTexts["Short task names"], "The seeded preference isn't listed.")
        try require(app.buttons["NewPreference"], "Preferences has no New preference button.").tap()
        try require(element("PreferenceInstruction"), "The preference form has no instruction field.").tap()
        app.typeText(instruction)
        element("PreferenceName").tap()
        app.typeText(name)
        let save = app.buttons["PreferenceSave"]
        try waitUntil(save, NSPredicate(format: "enabled == true"), "The preference can't be saved.")
        save.tap()
        let saved = try await eventually("the preference on the server") {
            try await server.list("/knowledge/preferences").first { $0["name"] as? String == name }
        }
        let preferenceID = try XCTUnwrap(saved["id"] as? String)
        XCTAssertEqual(saved["instruction"] as? String, instruction, "The saved instruction isn't what was typed.")
        XCTAssertTrue(saved["project"] == nil || saved["project"] is NSNull, "A preference saved for everywhere was tied to a project.")
        try require(app.staticTexts[name], "The new preference isn't listed.")
        snapshot("Organization preferences")

        try waitForToastToClear()
        let menu = button(labeled: "Actions for \(name)")
        try reveal(menu, "The new preference has no actions menu.")
        menu.tap()
        try require(button(labeled: "Archive"), "The preference menu has no Archive.").tap()
        try require(button(labeled: "Archive preference"), "Archiving didn't ask first.").tap()
        _ = try await eventually("the preference archived") {
            try await server.list("/knowledge/preferences").contains { $0["id"] as? String == preferenceID } ? nil : true
        }

        let notes = try await server.list("/search", [URLQueryItem(name: "q", value: "Cobalt supplier"), URLQueryItem(name: "limit", value: "20")])
            .filter { ($0["title"] as? String ?? "").hasPrefix("Cobalt supplier") }
        guard notes.count == 2 else { throw FixtureError("The knowledge fixture needs exactly two active “Cobalt supplier” notes.") }
        let ids = notes.compactMap { $0["id"] as? String }
        let bodies = try await Self.bodies(server, ids)

        app.navigationBars.buttons.element(boundBy: 0).tap()
        let freshness = app.buttons["Knowledge-freshness"]
        try reveal(freshness, "Knowledge has no Information review.")
        freshness.tap()
        app.segmentedControls["FreshnessMode"].buttons["Possible conflicts"].tap()
        try require(element("FreshnessTopic"), "Conflicts has no topic field.").tap()
        app.typeText("Cobalt supplier")
        try analyzeConflicts()

        let suggestion = app.descendants(matching: .any).matching(identifier: "FreshnessSuggestion")
            .containing(NSPredicate(format: "label CONTAINS %@", "Tuesday")).firstMatch
        // A rerun finds the pair already dismissed by an earlier run, which the counts below still check.
        if suggestion.waitForExistence(timeout: 3) {
            XCTAssertTrue(suggestion.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Friday")).firstMatch.exists,
                          "The suggestion doesn't quote both notes.")
            let analyzed = try await Self.bodies(server, ids)
            XCTAssertEqual(analyzed, bodies, "Looking for conflicts changed a note.")
            snapshot("Suggested conflict")
            let dismiss = suggestion.buttons["FreshnessDismiss"]
            try reveal(dismiss, "The suggestion has no Dismiss.")
            dismiss.tap()
            try require(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Dismissed;")).firstMatch, "Dismissing wasn't confirmed.")
            let dismissed = try await Self.bodies(server, ids)
            XCTAssertEqual(dismissed, bodies, "Dismissing rewrote a note.")
            try waitForToastToClear()
            try analyzeConflicts()
            try waitUntil(suggestion, NSPredicate(format: "exists == false"), "The dismissed pair was suggested again.")
        }
        let counted = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ AND NOT (label BEGINSWITH %@)", "already dismissed", "0")).firstMatch
        try require(counted, "The comparison doesn't count the dismissed pair.")
        let after = try await Self.bodies(server, ids)
        XCTAssertEqual(after, bodies, "Reviewing conflicts rewrote a note.")
    }

    /// Edits typed values on “Garden meeting” in “Garden work”, moves it on the board when the collection groups by Status,
    /// then puts every value back.
    func testCollectionTypedEditsLayoutsAndBoardMove() async throws {
        let server = try await launchKnowledge()
        let definition = try await server.named("/knowledge/collections", "Garden work")
        let collectionID = try XCTUnwrap(definition["id"] as? String)
        let meeting = try await server.knowledgeItem(titled: meetingTitle)
        let meetingID = try XCTUnwrap(meeting["id"] as? String)
        let original = try await Self.values(server, collection: collectionID, item: meetingID)
        guard let cost = original["Cost"] as? Double, let ordered = original["Ordered"] as? Bool,
              let supplier = original["Supplier"] as? String, let status = original["Status"] as? String else {
            throw FixtureError("“\(meetingTitle)” lacks its seeded Garden work Status, Cost, Ordered and Supplier values.")
        }
        let due = original["Due"] as? String
        let newCost: Double = cost == 95 ? 96 : 95
        let newSupplier = "Cedar Yard \(Self.marker())"

        try openKnowledge("collections")
        let row = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "CollectionRow", "Garden work")).firstMatch
        try reveal(row, "Collections doesn't list “Garden work”.")
        row.tap()
        try require(button(labeled: "Cost: \(Self.number(cost))"), "The table doesn't show the seeded cost.")
        try require(button(labeled: "Supplier: \(supplier)"), "The table doesn't show the seeded supplier.")
        try require(button(labeled: "Status: \(status)"), "The table doesn't show the seeded status.")
        snapshot("Collection table")

        app.segmentedControls["CollectionLayoutSwitch"].buttons["Cards"].tap()
        try editRow(meetingTitle, toggleOrdered: true, supplier: newSupplier, cost: newCost)
        let edited = try await eventually("the edited values on the server") {
            let values = try await Self.values(server, collection: collectionID, item: meetingID)
            return values["Cost"] as? Double == newCost ? values : nil
        }
        XCTAssertEqual(edited["Ordered"] as? Bool, !ordered, "The checkbox wasn't saved.")
        XCTAssertEqual(edited["Supplier"] as? String, newSupplier, "The text value wasn't saved.")
        XCTAssertEqual(edited["Status"] as? String, status, "Editing changed a field it didn't touch.")
        XCTAssertEqual(edited["Due"] as? String, due, "Editing changed a field it didn't touch.")
        try require(rowCard(meetingTitle).staticTexts.matching(NSPredicate(format: "label == %@", newSupplier)).firstMatch, "The card doesn't show the saved value.")
        snapshot("Collection cards")
        app.segmentedControls["CollectionLayoutSwitch"].buttons["Table"].tap()
        try require(button(labeled: "Cost: \(Self.number(newCost))"), "The table doesn't show the saved cost.")

        app.segmentedControls["CollectionLayoutSwitch"].buttons["Kanban"].tap()
        let statusField = (definition["fields"] as? [[String: Any]] ?? []).first { $0["name"] as? String == "Status" }
        if let groupBy = definition["groupBy"] as? String, groupBy == statusField?["id"] as? String {
            let target = status == "In progress" ? "Planned" : "In progress"
            try moveOnBoard(meetingTitle, to: target)
            _ = try await eventually("the board move on the server") {
                try await Self.values(server, collection: collectionID, item: meetingID)["Status"] as? String == target ? true : nil
            }
            snapshot("Collection board")
            try waitForToastToClear()
            try moveOnBoard(meetingTitle, to: status)
            _ = try await eventually("the board move back on the server") {
                try await Self.values(server, collection: collectionID, item: meetingID)["Status"] as? String == status ? true : nil
            }
        } else {
            try require(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Kanban needs a choice field")).firstMatch,
                        "Kanban without a group-by field doesn't say what it needs.")
        }

        app.segmentedControls["CollectionLayoutSwitch"].buttons["Cards"].tap()
        try editRow(meetingTitle, toggleOrdered: true, supplier: supplier, cost: cost)
        let restored = try await eventually("the original values on the server") {
            let values = try await Self.values(server, collection: collectionID, item: meetingID)
            return values["Cost"] as? Double == cost && values["Supplier"] as? String == supplier ? values : nil
        }
        XCTAssertEqual(restored["Ordered"] as? Bool, ordered, "The checkbox wasn't put back.")
        XCTAssertEqual(restored["Status"] as? String, status, "The status wasn't put back.")
        XCTAssertEqual(restored["Due"] as? String, due, "The due date changed.")
    }

    /// Page 1 of “Fictional field guide” is exactly “Raised beds need cedar boards.”; “Scanned field card” is image-only.
    func testPdfPagesWholePageAnnotationAndScannedPageReview() async throws {
        let server = try await launchKnowledge()
        let guide = try await server.knowledgeItem(titled: "Fictional field guide")
        let guideID = try XCTUnwrap(guide["id"] as? String)
        let scan = try await server.knowledgeItem(titled: "Scanned field card")
        let scanID = try XCTUnwrap(scan["id"] as? String)
        let wholePage = "Raised beds need cedar boards."
        let acrossPages = "cedar boards. The Aurora rocket"
        let marker = Self.marker()

        try openKnowledge("research")
        try openResearchSource("Fictional field guide")
        let pages = app.buttons["PdfPageMenu"]
        try waitUntil(pages, NSPredicate(format: "label == %@", "Page 1 of 2"), "The PDF didn't open on page 1 of 2.")
        let pdf = try require(element("PdfView"), "PDFKit didn't show the original.")
        try waitUntil(element("PdfPageText"), NSPredicate(format: "label CONTAINS %@", wholePage), "Page 1's kept text isn't shown.")
        for _ in 0..<4 where pages.label != "Page 2 of 2" { pdf.swipeUp() }
        try waitUntil(pages, NSPredicate(format: "label == %@", "Page 2 of 2"), "Scrolling the PDF didn't reach page 2.")
        try waitUntil(element("PdfPageText"), NSPredicate(format: "label CONTAINS %@", "The Aurora rocket burns methane."), "Page 2's text didn't follow the scroll.")
        snapshot("PDF page 2")
        app.buttons["PdfPrevious"].tap()
        try waitUntil(pages, NSPredicate(format: "label == %@", "Page 1 of 2"), "Previous page didn't return to page 1.")

        app.segmentedControls["PdfPanel"].buttons["Find"].tap()
        try require(element("PdfFindField"), "The PDF has no Find field.").tap()
        app.typeText("methane\n")
        let match = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "PdfFindResult", "Page 2")).firstMatch
        try require(match, "Find didn't locate page 2's text.").tap()
        try waitUntil(pages, NSPredicate(format: "label == %@", "Page 2 of 2"), "Opening the match didn't go to page 2.")
        app.buttons["PdfPrevious"].tap()
        try waitUntil(pages, NSPredicate(format: "label == %@", "Page 1 of 2"), "Previous page didn't return to page 1.")

        app.buttons["PdfMenu"].tap()
        try require(app.buttons["PdfAnnotatePage"], "The PDF menu has no accessible annotation action.").tap()
        let quote = try require(element("AnnotationQuote"), "Annotate didn't open with the selection.")
        try require(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Quote from page 1")).firstMatch, "The selection isn't anchored to page 1.")
        let save = app.buttons["AnnotationSave"]

        replaceText(in: quote, with: acrossPages)
        save.tap()
        try await Task.sleep(for: .seconds(2))
        try waitUntil(save, NSPredicate(format: "label == %@ AND enabled == true", "Save"), "A quote running onto page 2 wasn't refused.")
        let leaked = try await Self.annotations(server, guideID).contains { $0["quote"] as? String == acrossPages }
        XCTAssertFalse(leaked, "A quote running onto page 2 was saved against page 1.")

        replaceText(in: quote, with: wholePage)
        snapshot("Whole-page annotation")
        save.tap()
        try waitUntil(quote, NSPredicate(format: "exists == false"), "The whole-page quote wasn't saved.")
        let annotation = try await eventually("the whole-page annotation") {
            try await Self.annotations(server, guideID).first { $0["quote"] as? String == wholePage && $0["page"] as? Int == 1 }
        }
        XCTAssertEqual(annotation["status"] as? String, "current", "The whole-page quote isn't anchored to the page.")
        let locator = annotation["locator"] as? [String: Any]
        XCTAssertEqual(locator?["start"] as? Int, 0, "The whole-page quote doesn't start at the page's first character.")
        XCTAssertEqual(locator?["end"] as? Int, wholePage.utf16.count, "The whole-page quote doesn't end at the page's last character.")
        try require(app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "PdfAnnotationRow", wholePage)).firstMatch,
                    "The annotation isn't listed.")
        let annotated = try await server.item(guideID)
        XCTAssertEqual(Self.attachmentKeys(annotated), Self.attachmentKeys(guide), "Annotating changed the PDF.")

        try waitForToastToClear()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let earlierOCR = try await Self.ocrText(server, scanID)
        try openResearchSource("Scanned field card")
        try require(element("PdfView"), "PDFKit didn't show the scanned original.")
        try require(app.buttons["PdfMenu"], "The PDF has no actions menu.").tap()
        let recognizeItem = button(labeled: "Recognize text on this page")
        try waitUntil(recognizeItem, NSPredicate(format: "enabled == true"), "Recognizing the scanned page isn't offered.")
        recognizeItem.tap()
        let draft = try require(element("PdfOcrDraft"), "Recognizing didn't open the review.")
        app.buttons["PdfOcrRecognize"].tap()
        try waitUntil(draft, NSPredicate(format: "value CONTAINS[c] %@", "MEMORY KEEPS IDEAS"), "Vision didn't read the scanned page.")
        let unsaved = try await Self.ocrText(server, scanID)
        XCTAssertEqual(unsaved, earlierOCR, "Recognizing saved text before Save.")
        draft.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.97)).tap()
        app.typeText(" Checked \(marker)")
        try waitUntil(draft, NSPredicate(format: "value CONTAINS %@", marker), "The reviewed draft can't be edited.")
        snapshot("Scanned page review")
        let saveOCR = app.buttons["PdfOcrSave"]
        try waitUntil(saveOCR, NSPredicate(format: "enabled == true"), "The reviewed text can't be saved.")
        saveOCR.tap()
        try waitUntil(draft, NSPredicate(format: "exists == false"), "Saving didn't close the review.")
        let reviewed = try await eventually("the reviewed page text on the server") {
            try await Self.ocrText(server, scanID).flatMap { $0.contains(marker) ? $0 : nil }
        }
        XCTAssertTrue(reviewed.localizedCaseInsensitiveContains("MEMORY KEEPS IDEAS"), "The saved text isn't what Vision read.")
        try require(app.staticTexts["Reviewed OCR text"], "The page doesn't show its reviewed text.")

        app.segmentedControls["PdfPanel"].buttons["Find"].tap()
        try require(element("PdfFindField"), "The PDF has no Find field.").tap()
        app.typeText("garden notes\n")
        try require(app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "PdfFindResult", "OCR")).firstMatch,
                    "Find doesn't search the reviewed text.")
        let scanned = try await server.item(scanID)
        XCTAssertEqual(Self.attachmentKeys(scanned), Self.attachmentKeys(scan), "Saving reviewed text changed the PDF.")
        app.buttons["PdfMenu"].tap()
        try require(app.buttons["PdfAnnotatePage"], "A scanned page can't be annotated from its reviewed text.").tap()
        let scannedQuote = try require(element("AnnotationQuote"), "The scanned page has no quote draft.")
        scannedQuote.tap()
        app.typeText("MEMORY KEEPS IDEAS")
        app.buttons["AnnotationSave"].tap()
        try waitUntil(scannedQuote, NSPredicate(format: "exists == false"), "The reviewed OCR quote wasn't saved.")
        let ocrQuote = try await eventually("the scanned-page annotation") {
            try await Self.annotations(server, scanID).first { $0["quote"] as? String == "MEMORY KEEPS IDEAS" }
        }
        XCTAssertEqual(ocrQuote["textSource"] as? String, "ocr")
        XCTAssertEqual(ocrQuote["status"] as? String, "current")
    }

    /// “Garden recording” is 10 s of silence with a saved transcript: 0–2 s “Welcome to the garden meeting.”, 2–5 s “Order cedar boards for the raised beds.”
    func testTranscriptSeekPassageAndRecordingDraftDismissal() async throws {
        let server = try await launchKnowledge()
        let recording = try await server.knowledgeItem(titled: "Garden recording")
        let audioID = try XCTUnwrap(recording["id"] as? String)
        let transcripts = try await server.object("/knowledge/research/audio/\(audioID)")["transcripts"] as? [[String: Any]] ?? []
        guard let transcript = transcripts.first(where: { $0["segmentCount"] as? Int == 2 }),
              let transcriptID = transcript["id"] as? String, let transcriptTitle = transcript["title"] as? String else {
            throw FixtureError("“Garden recording” has no saved two-cue transcript.")
        }
        let sourcesBefore = try await Self.researchSourceCount(server)

        try openKnowledge("research")
        try require(app.buttons["ResearchRecord"], "PDFs and recordings has no Record button.").tap()
        let record = try require(app.buttons["RecordingStart"], "The recorder didn't offer Record.")
        XCTAssertFalse(element("RecordingProblem").exists, "The recorder reported a problem before Record was tapped.")
        snapshot("Recorder")
        app.navigationBars["Record audio"].buttons["Close"].tap()
        try waitUntil(record, NSPredicate(format: "exists == false"), "Close didn't dismiss the recorder.")
        let sourcesAfter = try await Self.researchSourceCount(server)
        XCTAssertEqual(sourcesAfter, sourcesBefore, "Closing the recorder saved something.")

        try openResearchSource("Garden recording")
        let row = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "TranscriptRow", transcriptTitle)).firstMatch
        try reveal(row, "The recording doesn't list its transcript.")
        row.tap()
        let play = app.buttons["AudioPlay"]
        try waitUntil(play, NSPredicate(format: "enabled == true"), "The recording didn't load for playback.")
        let position = app.sliders["Position"]
        let welcome = cue("Welcome to the garden meeting.")
        let order = cue("Order cedar boards for the raised beds.")

        try reveal(order, "The transcript doesn't show its second cue.")
        order.tap()
        try waitUntil(play, NSPredicate(format: "label == %@", "Pause"), "Tapping a cue didn't start playback.")
        try waitUntil(position, NSPredicate(format: "value IN %@", ["0:03", "0:04"]), "Playback didn't run on from the second cue at 0:02.")
        try reveal(play, "The player has no Pause button.")
        play.tap()
        try waitUntil(play, NSPredicate(format: "label == %@", "Play"), "Pause didn't stop playback.")
        snapshot("Transcript playing from a cue")

        let choose = app.buttons["TranscriptChoose"]
        try reveal(choose, "The transcript has no Quote a passage.")
        choose.tap()
        try reveal(welcome, "The transcript doesn't show its first cue.")
        welcome.tap()
        try reveal(order, "The transcript doesn't show its second cue.")
        order.tap()
        try require(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Cues 1–2, 0:00 to 0:05")).firstMatch,
                    "Choosing the first and last cues didn't select the passage.")
        let savePassage = app.buttons["PassageSave"]
        try reveal(savePassage, "The passage has no Save.")
        try waitUntil(savePassage, NSPredicate(format: "enabled == true"), "The chosen passage can't be saved.")
        savePassage.tap()
        let passage = try await eventually("the passage on the server") {
            try await server.list("/knowledge/research/transcripts/\(transcriptID)/passages").first { $0["from"] as? Int == 0 && $0["to"] as? Int == 1 }
        }
        XCTAssertEqual(passage["start"] as? Double, 0, "The passage doesn't start at the first cue.")
        XCTAssertEqual(passage["end"] as? Double, 5, "The passage doesn't end with the second cue.")
        let quoted = passage["quote"] as? String ?? ""
        XCTAssertTrue(quoted.contains("Welcome to the garden meeting.") && quoted.contains("Order cedar boards for the raised beds."),
                      "The passage doesn't quote both cues.")

        try waitForToastToClear()
        let saved = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "PassageRow", "0:00–0:05")).firstMatch
        try reveal(saved, "The saved passage isn't listed.")
        saved.tap()
        try waitUntil(position, NSPredicate(format: "value IN %@", ["0:00", "0:01", "0:02"]), "The saved passage didn't play from its start.")
        try waitUntil(play, NSPredicate(format: "label == %@", "Pause"), "The saved passage didn't start playback.")
        try reveal(play, "The player has no Pause button.")
        play.tap()
    }

    /// “Field documents” has its folder approved on the host with one top-level “Field observation.txt”; “Field feed” reads a local RSS fixture.
    func testWatchedFolderCheckReviewApplyAndFeedCheck() async throws {
        let server = try await launchKnowledge()
        let folder = try await server.named("/knowledge/sources", "Field documents")
        let feed = try await server.named("/knowledge/sources", "Field feed")
        let folderID = try XCTUnwrap(folder["id"] as? String)
        let feedID = try XCTUnwrap(feed["id"] as? String)

        try openKnowledge("sources")
        try openWatch("Field documents")
        try require(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "approved and readable")).firstMatch,
                    "The folder isn't approved and readable on the host.")
        let folderCheck = try await checkNow(server, folderID)
        XCTAssertEqual(folderCheck["status"] as? String, "ok", "The folder check failed: \(folderCheck["error"] ?? "")")
        let queue = try await server.object("/knowledge/sources/\(folderID)/queue")
        let waiting = (queue["candidates"] as? [[String: Any]] ?? [])
            .first { ($0["file"] as? [String: Any])?["name"] as? String == "Field observation.txt" }
        // A rerun finds the document already imported and unchanged.
        if let candidate = waiting {
            let candidateID = try XCTUnwrap(candidate["id"] as? String)
            let title = try XCTUnwrap(candidate["title"] as? String)
            let earlier = try await Self.itemIDs(server, titled: title)
            let tick = app.switches.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "WatchCandidate", title)).firstMatch
            try reveal(tick, "“\(title)” isn't waiting for review.")
            XCTAssertEqual(tick.value as? String, "0", "A preview was ticked without asking.")
            tick.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            try waitUntil(tick, NSPredicate(format: "value == %@", "1"), "Ticking the preview didn't take.")
            let apply = app.buttons["WatchApply"]
            try reveal(apply, "The queue has no Apply.")
            try waitUntil(apply, NSPredicate(format: "label == %@ AND enabled == true", "Apply 1"), "Apply doesn't reflect the ticked preview.")
            let unapplied = try await Self.itemIDs(server, titled: title)
            XCTAssertEqual(unapplied, earlier, "Checking imported the document before Apply.")
            snapshot("Watched folder review")
            apply.tap()
            try require(app.staticTexts["Applied 1"], "Applying didn't confirm the import.")
            _ = try await eventually("the imported document") {
                try await Self.itemIDs(server, titled: title).subtracting(earlier).first
            }
            let after = try await server.object("/knowledge/sources/\(folderID)/queue")
            XCTAssertFalse((after["candidates"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == candidateID }, "The applied preview is still waiting.")
        } else {
            XCTAssertGreaterThan(folderCheck["unchanged"] as? Int ?? 0, 0, "The check neither queued nor recognized “Field observation.txt”.")
        }

        try waitForToastToClear()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        try openWatch("Field feed")
        let feedCheck = try await checkNow(server, feedID)
        XCTAssertEqual(feedCheck["status"] as? String, "ok", "The feed check failed: \(feedCheck["error"] ?? "")")
        let feedQueue = try await server.object("/knowledge/sources/\(feedID)/queue")
        let feedWaiting = feedQueue["candidates"] as? [[String: Any]] ?? []
        if !feedWaiting.isEmpty {
            try require(app.switches.matching(identifier: "WatchCandidate").firstMatch, "The feed's previews aren't shown for review.")
            let apply = app.buttons["WatchApply"]
            try reveal(apply, "The feed's queue has no Apply.")
            XCTAssertFalse(apply.isEnabled, "Apply is offered with nothing ticked.")
        }
        snapshot("Watched feed")
    }

    // MARK: Steps

    private func launchKnowledge() async throws -> ScratchServer {
        _ = try Fixture.required("MEMORY_KNOWLEDGE_FIXTURE", for: "the knowledge journeys against the seeded knowledge fixture")
        return try await launchPaired()
    }

    private func requireAI(_ server: ScratchServer) async throws {
        guard try await server.object("/ai/status")["configured"] as? Bool == true else {
            throw FixtureError("The knowledge fixture's host has no deterministic AI configured.")
        }
    }

    private func openKnowledge(_ area: String) throws {
        try openLibraryTool("OpenKnowledge")
        let connecting = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Connecting to your computer")).firstMatch
        try waitUntil(connecting, NSPredicate(format: "exists == false"), "Knowledge never reached the host.")
        let row = app.buttons["Knowledge-\(area)"]
        try reveal(row, "Knowledge has no “\(area)” area.")
        row.tap()
    }

    private func button(labeled label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func workflowCard(_ name: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "WorkflowCard").containing(NSPredicate(format: "label == %@", name)).firstMatch
    }

    /// The card's title button reads “<type>, <title>”, so a longer title ending the same way doesn't match.
    private func rowCard(_ title: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "CollectionCard")
            .containing(NSPredicate(format: "label == %@ OR label ENDSWITH %@", title, " \(title)")).firstMatch
    }

    private func cue(_ text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "TranscriptCue", text)).firstMatch
    }

    private func openResearchSource(_ title: String) throws {
        let row = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "ResearchSourceRow", title)).firstMatch
        try reveal(row, "PDFs and recordings doesn't list “\(title)”.")
        row.tap()
    }

    private func openWatch(_ name: String) throws {
        let row = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "WatchedSourceRow", name)).firstMatch
        try reveal(row, "Watched sources doesn't list “\(name)”.")
        row.tap()
    }

    /// Clears the field from its end and types the replacement.
    private func replaceText(in field: XCUIElement, with text: String) {
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let current = field.value as? String ?? ""
        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
    }

    private func scrollIntoView(_ element: XCUIElement, _ message: String) throws {
        for _ in 0..<4 where !element.exists || !element.isHittable { app.swipeUp() }
        for _ in 0..<4 where !element.exists || !element.isHittable { app.swipeDown() }
        try require(element, message)
    }

    /// Fields are edited bottom-up so the keyboard never covers the next one.
    private func editRow(_ title: String, toggleOrdered: Bool, supplier: String, cost: Double) throws {
        let edit = rowCard(title).buttons["CollectionEditRow"]
        try reveal(edit, "The cards layout has no “\(title)” card.")
        edit.tap()
        let ordered = try require(app.switches["FieldCheckbox"], "Editing has no Ordered checkbox.")
        if toggleOrdered {
            let before = ordered.value as? String ?? ""
            ordered.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            try waitUntil(ordered, NSPredicate(format: "value != %@", before), "The checkbox didn't change.")
        }
        let text = element("FieldText")
        try scrollIntoView(text, "Editing has no Supplier field.")
        replaceText(in: text, with: supplier)
        let number = element("FieldNumber")
        try scrollIntoView(number, "Editing has no Cost field.")
        replaceText(in: number, with: Self.number(cost))
        let save = app.buttons["FieldValuesSave"]
        try waitUntil(save, NSPredicate(format: "enabled == true"), "The edited values can't be saved.")
        save.tap()
        try waitUntil(save, NSPredicate(format: "exists == false"), "Saving didn't close the editor.")
    }

    /// The board rebuilds after each move, so the card is found again and the columns scrolled until it's reachable.
    private func moveOnBoard(_ title: String, to target: String) throws {
        let board = try require(element("CollectionBoard"), "Kanban didn't show a board.")
        let move = rowCard(title).buttons["CollectionMove"]
        for _ in 0..<4 where !(move.exists && move.isHittable) { board.swipeLeft() }
        for _ in 0..<4 where !(move.exists && move.isHittable) { board.swipeRight() }
        try require(move, "The board doesn't show “\(title)”.").tap()
        try require(button(labeled: target), "Moving doesn't offer “\(target)”.").tap()
    }

    private func analyzeConflicts() throws {
        let analyze = app.buttons["FreshnessAnalyze"]
        try reveal(analyze, "Conflicts has no Look for conflicts.")
        try waitUntil(analyze, NSPredicate(format: "enabled == true"), "Looking for conflicts is disabled.")
        analyze.tap()
        try require(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "items compared")).firstMatch,
                    "Looking for conflicts didn't answer.")
    }

    /// Taps Check now and returns the host's record of that check.
    private func checkNow(_ server: ScratchServer, _ id: String) async throws -> [String: Any] {
        let check = app.buttons["WatchCheck"]
        try reveal(check, "The watch has no Check now.")
        try waitUntil(check, NSPredicate(format: "enabled == true"), "Check now is disabled.")
        let started = Date.now.addingTimeInterval(-5)
        check.tap()
        let last = try await eventually("the check on the host") {
            let last = try await server.object("/knowledge/sources/\(id)")["lastCheck"] as? [String: Any]
            return Self.timestamp(last?["at"]).map { $0 >= started } == true ? last : nil
        }
        try waitUntil(check, NSPredicate(format: "label CONTAINS %@ AND enabled == true", "Check now"), "The check didn't finish on the phone.")
        return last
    }

    private func assertUnchanged(_ server: ScratchServer, _ id: String, body: String?, tags: Set<String>, _ message: String) async throws {
        let item = try await server.item(id)
        XCTAssertEqual(item["body"] as? String, body, message)
        XCTAssertEqual(Set(item["tags"] as? [String] ?? []), tags, message)
    }

    // MARK: Reading the server

    /// Digits only: autocorrect leaves them alone, and search finds them.
    private static func marker() -> String { String(Int.random(in: 10_000_000...99_999_999)) }

    /// As the collection shows a whole number: without a decimal point or grouping.
    private static func number(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(value)
    }

    private static func ids(_ server: ScratchServer, type: String, titled title: String) async throws -> Set<String> {
        let items = try await server.list("/items", [URLQueryItem(name: "type", value: type), URLQueryItem(name: "limit", value: "100")])
        return Set(items.filter { $0["title"] as? String == title }.compactMap { $0["id"] as? String })
    }

    private static func itemIDs(_ server: ScratchServer, titled title: String) async throws -> Set<String> {
        let hits = try await server.list("/search", [URLQueryItem(name: "q", value: title), URLQueryItem(name: "limit", value: "50")])
        return Set(hits.filter { $0["title"] as? String == title }.compactMap { $0["id"] as? String })
    }

    private static func bodies(_ server: ScratchServer, _ ids: [String]) async throws -> [String: String] {
        var bodies: [String: String] = [:]
        for id in ids { bodies[id] = try await server.item(id)["body"] as? String ?? "" }
        return bodies
    }

    /// One item's values in a collection by field name, with choices as their option names.
    private static func values(_ server: ScratchServer, collection id: String, item: String) async throws -> [String: Any] {
        let page = try await server.object("/knowledge/collections/\(id)/rows", [URLQueryItem(name: "limit", value: "50")])
        guard let row = (page["rows"] as? [[String: Any]] ?? []).first(where: { ($0["item"] as? [String: Any])?["id"] as? String == item }) else {
            throw FixtureError("The collection doesn't include the item \(item).")
        }
        let stored = row["values"] as? [String: Any] ?? [:]
        var named: [String: Any] = [:]
        for field in (page["collection"] as? [String: Any])?["fields"] as? [[String: Any]] ?? [] {
            guard let fieldID = field["id"] as? String, let name = field["name"] as? String, let value = stored[fieldID] else { continue }
            if field["type"] as? String == "select" {
                named[name] = (field["options"] as? [[String: Any]] ?? []).first { $0["id"] as? String == value as? String }?["name"]
            } else {
                named[name] = value
            }
        }
        return named
    }

    private static func annotations(_ server: ScratchServer, _ id: String) async throws -> [[String: Any]] {
        try await server.list("/knowledge/research/pdf/\(id)/annotations")
    }

    private static func ocrText(_ server: ScratchServer, _ id: String) async throws -> String? {
        let range = try await server.object("/knowledge/research/pdf/\(id)/pages", [URLQueryItem(name: "from", value: "1"), URLQueryItem(name: "limit", value: "1")])
        return ((range["pages"] as? [[String: Any]])?.first?["ocr"] as? [String: Any])?["text"] as? String
    }

    private static func researchSourceCount(_ server: ScratchServer) async throws -> Int {
        (try await server.object("/knowledge/research/sources")["items"] as? [Any])?.count ?? 0
    }

    private static func attachmentKeys(_ item: [String: Any]) -> [String] {
        (item["attachments"] as? [[String: Any]] ?? []).map { "\($0["id"] ?? "") \($0["sha256"] ?? "")" }.sorted()
    }

    private static func timestamp(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

private extension ScratchServer {
    /// The knowledge fixture's active item with exactly this title, in full.
    func knowledgeItem(titled title: String) async throws -> [String: Any] {
        let hits = try await list("/search", [URLQueryItem(name: "q", value: title), URLQueryItem(name: "limit", value: "20")])
        guard let id = hits.first(where: { $0["title"] as? String == title })?["id"] as? String else {
            throw FixtureError("The knowledge fixture has no active item titled “\(title)”.")
        }
        return try await item(id)
    }

    /// The workflow, preference, collection or watch at `path` with exactly this name.
    func named(_ path: String, _ name: String) async throws -> [String: Any] {
        guard let match = try await list(path).first(where: { $0["name"] as? String == name }) else {
            throw FixtureError("The knowledge fixture has nothing named “\(name)” at \(path).")
        }
        return match
    }
}
