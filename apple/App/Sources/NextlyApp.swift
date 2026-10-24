// The native Nextly app for iPhone, iPad and Mac.

import NextlyKit
import SwiftUI

@main
struct NextlyApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Theme.registerFonts()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        #if os(macOS)
        // One window: the selection and the undo toast belong to it.
        Window("Nextly", id: "main") { root }
            .defaultSize(width: 1100, height: 720)
            .commands { NextlyCommands(model: model) }
        Settings {
            SettingsView(model: model)
                .frame(minWidth: 520, idealWidth: 600, minHeight: 520)
                .font(Theme.body())
                .tint(Theme.plum)
        }
        #else
        WindowGroup { root }
            .commands { NextlyCommands(model: model) }
        #endif
    }

    private var root: some View {
        ContentView(model: model)
            .font(Theme.body())
            .tint(Theme.plum)
            .onAppear { model.start() }
            .onOpenURL { model.handle($0) }
            .onChange(of: scenePhase) { _, phase in if phase == .active { model.becameActive() } }
    }
}

/// Menu commands and their shortcuts (App.tsx). On iPad they show when you hold ⌘.
struct NextlyCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Task") { model.focusQuickAdd += 1 }
                .keyboardShortcut("n")
        }
        CommandMenu("Task") {
            let selected = model.selectedTaskId
            Button("Search") { model.focusSearch += 1 }
                .keyboardShortcut("k")
            Divider()
            Button("In Progress") { if let s = selected { model.store.setFlag(s, .doing) } }
                .keyboardShortcut("d")
                .disabled(selected == nil)
            Button("Today") { if let s = selected { model.store.setFlag(s, .today) } }
                .keyboardShortcut("t")
                .disabled(selected == nil)
            Button("Next") { if let s = selected { model.store.setFlag(s, .next) } }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(selected == nil)
            Button("Complete") { if let s = selected { model.store.toggleDone(s) } }
                .keyboardShortcut(.return)
                .disabled(selected == nil)
            Divider()
            // ⌘⌫; plain Delete works in the list too (onDeleteCommand), and
            // Esc closes the details (onExitCommand) without stealing Esc from text fields.
            Button("Delete Task") { if let s = selected { model.remove(s) } }
                .keyboardShortcut(.delete)
                .disabled(selected == nil)
            #if !os(macOS)
            Divider()
            Button("Settings") { model.showSettings = true }
                .keyboardShortcut(",")
            #endif
        }
    }
}
