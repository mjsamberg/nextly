// Three columns on Mac and iPad (lists, tasks, details); one screen at a
// time on iPhone, with the system's swipe from the edge to go back.

import NextlyKit
import SwiftUI

struct ContentView: View {
    @Bindable var model: AppModel
    @State private var compactColumn = NavigationSplitViewColumn.sidebar

    var body: some View {
        if let fatal = model.fatal {
            Text(fatal).padding().foregroundStyle(Theme.danger)
        } else {
            split
        }
    }

    private var split: some View {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            SidebarView(model: model)
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
        } content: {
            Group {
                if let list = model.list {
                    TaskListView(model: model, list: list)
                } else {
                    Text("Pick a list.").foregroundStyle(.secondary)
                }
            }
            .navigationSplitViewColumnWidth(min: 320, ideal: 420)
        } detail: {
            if let task = model.selectedTask {
                DetailView(model: model, task: task)
                    .id(task.id)
            } else {
                Text("Select a task to see its details.")
                    .foregroundStyle(.secondary)
            }
        }
        .overlay(alignment: .bottom) { toast }
        .sheet(isPresented: Binding(get: { model.store.resolvingId != nil }, set: { if !$0 { model.store.cancelResolve() } })) {
            if let id = model.store.resolvingId, let t = model.view.task(id) {
                ResolveSheet(model: model, task: t)
            }
        }
        #if !os(macOS)
        .sheet(isPresented: $model.showSettings) {
            NavigationStack {
                SettingsView(model: model)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.showSettings = false } } }
            }
            .font(Theme.body())
            .tint(Theme.plum)
        }
        #endif
        // The selected task was deleted or synced away.
        .onChange(of: model.view.task(model.selectedTaskId ?? "") == nil) { _, gone in
            if gone && model.selectedTaskId != nil { model.selectedTaskId = nil }
        }
    }

    @ViewBuilder private var toast: some View {
        if let t = model.toast {
            HStack(spacing: 12) {
                Text(t.text).lineLimit(2)
                if let undo = t.undo {
                    Button("Undo") { undo(); model.toast = nil }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.gold)
                        .fontWeight(.bold)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .foregroundStyle(.white)
            .background(Theme.navy, in: Capsule())
            .padding(.bottom, 24)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .combine)
        }
    }
}

/// Asks for resolution notes before an Incident IQ ticket's task is completed (ResolveDialog.tsx).
struct ResolveSheet: View {
    let model: AppModel
    let task: TaskItem
    @State private var notes = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Resolve ticket #\(task.external?.number.text ?? "?")").font(Theme.heading(22, relativeTo: .title2))
            Text(task.title).font(Theme.small).foregroundStyle(.secondary)
            Text("Resolution notes").font(Theme.body(.semibold))
            TextEditor(text: $notes)
                .focused($focused)
                .frame(minHeight: 110)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            Text("Saved to the ticket in Incident IQ with your resolution action.")
                .font(Theme.small).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { model.store.cancelResolve() }
                    .keyboardShortcut(.cancelAction)
                Button("Resolve") { model.store.resolveWithNotes(task.id, notes) }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .disabled(notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 380)
        .onAppear { focused = true }
    }
}

extension JSONValue {
    /// A ticket number as text, whether IIQ sent a number or a string.
    var text: String? {
        switch self {
        case .string(let s): s
        case .number(let n): n == n.rounded() ? String(Int(n)) : String(n)
        default: nil
        }
    }
}
