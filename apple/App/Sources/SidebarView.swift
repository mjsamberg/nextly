// The list of lists: Inbox to Logbook with counts, then areas and their
// projects, search, Settings and the sync dot (Sidebar.tsx).

import NextlyKit
import SwiftUI

struct SidebarView: View {
    @Bindable var model: AppModel
    /// Where a new project or area is being typed: an area id, `noArea`, `newArea`, or nil.
    @State private var adding: String?
    @FocusState private var searchFocused: Bool

    private static let noArea = "__no-area__", newArea = "__new-area__"

    private static let main: [(ListView, String, String, Color?)] = [
        (.inbox, "Inbox", "tray", nil),
        (.doing, "In Progress", "play.fill", Theme.teal),
        (.today, "Today", "star.fill", Theme.gold),
        (.next, "Next", "arrow.right.circle", Theme.navy),
        (.scheduled, "Scheduled", "calendar", nil),
        (.someday, "Someday", "archivebox", nil),
        (.all, "All", "square.stack", nil),
        (.logbook, "Logbook", "checkmark.circle", nil),
    ]

    var body: some View {
        let v = model.view
        let c = Lists.counts(v)
        // Picking a list also closes the open task and clears search (App.tsx go()).
        List(selection: Binding(get: { model.list }, set: { if let l = $0 { model.go(l) } else { model.list = nil } })) {
            Section {
                ForEach(Self.main, id: \.0) { item in
                    let n = count(c, item.0)
                    Label { Text(item.1) } icon: { Image(systemName: item.2).foregroundStyle(item.3 ?? Theme.plum) }
                        .badge(n)
                        .tag(item.0)
                }
            }
            ForEach(groups(v), id: \.key) { g in
                Section {
                    ForEach(g.projects) { p in
                        let n = v.tasks.filter { $0.projectId == p.id && !$0.done && $0.parentId == nil }.count
                        Label(p.title.nonEmpty ?? "Untitled project", systemImage: "folder")
                            .badge(n)
                            .tag(ListView.project(p.id))
                    }
                    if adding == g.key {
                        NameField(placeholder: g.area.map { "New project in \($0.title)" } ?? "Project name") { name in
                            adding = nil
                            if let name { model.go(.project(model.store.createProject(name, areaId: g.area?.id))) }
                        }
                    }
                } header: {
                    HStack {
                        Text(g.title)
                        Spacer()
                        Button { adding = g.key } label: { Image(systemName: "plus") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("New project in \(g.title)")
                            .help("New project in \(g.title)")
                    }
                }
            }
            Section {
                if adding == Self.newArea {
                    NameField(placeholder: "Area name, like Classroom") { name in
                        adding = nil
                        if let name { _ = model.store.createArea(name) }
                    }
                }
                Button { adding = Self.noArea } label: { Label("New project", systemImage: "plus") }
                    .buttonStyle(.borderless)
                Button { adding = Self.newArea } label: { Label("New area", systemImage: "plus") }
                    .buttonStyle(.borderless)
            }
            .foregroundStyle(.secondary)
        }
        .searchable(text: $model.query, placement: .sidebar, prompt: "Search")
        .searchFocusedIfAvailable($searchFocused)
        .onChange(of: model.focusSearch) { searchFocused = true }
        .navigationTitle("Nextly")
        .safeAreaInset(edge: .bottom) { footer }
    }

    private var footer: some View {
        HStack {
            #if os(macOS)
            SettingsLink { Label("Settings", systemImage: "gearshape") }
                .buttonStyle(.borderless)
            #else
            Button { model.showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                .buttonStyle(.borderless)
            #endif
            Spacer()
            SyncDot(state: model.sync.status.state.rawValue)
                .help(model.sync.status.message)
                .accessibilityLabel("Sync: \(model.sync.status.message)")
                .accessibilityHidden(false)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func count(_ c: Lists.Counts, _ l: ListView) -> Int {
        switch l {
        case .inbox: c.inbox
        case .doing: c.doing
        case .today: c.today
        case .next: c.next
        default: 0
        }
    }

    private struct Group {
        var key: String
        var title: String
        var area: AreaItem?
        var projects: [ProjectItem]
    }

    /// Areas with their projects; then projects without an area, under
    /// "Other projects" (or "Projects" when there are no areas).
    private func groups(_ v: ViewData) -> [Group] {
        var out = v.areas.map { a in Group(key: a.id, title: a.title.nonEmpty ?? "Untitled area", area: a, projects: v.projects.filter { $0.areaId == a.id }) }
        let loose = v.projects.filter { p in p.areaId == nil || !v.areas.contains { $0.id == p.areaId } }
        if v.areas.isEmpty || !loose.isEmpty || adding == Self.noArea {
            out.append(Group(key: Self.noArea, title: v.areas.isEmpty ? "Projects" : "Other projects", area: nil, projects: loose))
        }
        return out
    }
}

/// Inline name field: Return saves; an empty name, or leaving the field, cancels.
struct NameField: View {
    var placeholder: String
    var onDone: (String?) -> Void
    @State private var name = ""
    @State private var finished = false
    @FocusState private var focused: Bool

    var body: some View {
        TextField(placeholder, text: $name)
            .focused($focused)
            .onSubmit { finish(name) }
            .onAppear { focused = true }
            .onChange(of: focused) { _, f in if !f { finish(name) } }
            #if os(macOS)
            .onExitCommand { finish("") }
            #endif
    }

    private func finish(_ value: String) {
        guard !finished else { return }
        finished = true
        let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
        onDone(t.isEmpty ? nil : t)
    }
}

private extension View {
    /// ⌘K focuses search on macOS 15 and iOS 18; on older systems the menu item does nothing.
    @ViewBuilder func searchFocusedIfAvailable(_ focused: FocusState<Bool>.Binding) -> some View {
        if #available(macOS 15, iOS 18, *) { searchFocused(focused) } else { self }
    }
}
