// Settings: sync server, Incident IQ status, areas and projects, keyboard
// help, and privacy (Settings.tsx). The student-information warnings are the
// district's wording and match the Windows app's word for word.

import NextlyKit
import SwiftUI

struct SettingsView: View {
    let model: AppModel
    @State private var url = ""
    @State private var altUrl = ""
    @State private var token = ""
    @State private var headers: [Logic.HeaderRow] = []
    @State private var loaded = false
    @State private var newArea = ""
    @State private var diag: (ok: Bool, lines: [String])?
    @State private var checking = false
    @State private var iiq: IiqStatus??

    private var sync: SyncClient { model.sync }
    private var store: LocalStore { model.store }

    var body: some View {
        Form {
            syncSection
            iiqSection
            areasSection
            keyboardSection
            Section("Privacy") {
                Text("Notes and attachments sync to your own server, not a district system. Keep student records such as grades, IEP or 504 details out of Nextly. Directory information, like a name on a conference list, is the most you should store.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .onAppear {
            guard !loaded else { return }
            loaded = true
            let s = sync.settings
            url = s.url; altUrl = s.altUrl; token = s.token; headers = s.headers
        }
        .task(id: sync.status.lastSync) { iiq = .some(await sync.iiqStatus()) }
    }

    // MARK: - Sync

    private func validUrl(_ u: String) -> Bool {
        let t = u.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || t.range(of: #"^https?://[^\s/]+"#, options: .regularExpression) != nil
    }

    @ViewBuilder private var syncSection: some View {
        let urlOk = validUrl(url)
        let altOk = validUrl(altUrl) && (altUrl.trimmingCharacters(in: .whitespaces).isEmpty || !url.trimmingCharacters(in: .whitespaces).isEmpty)
        let headerError = Logic.checkHeaders(headers)
        let hasAccess = headers.contains { $0.name.lowercased().hasPrefix("cf-access-client-") }
        Section {
            Text("Point every device at the same Nextly server, for example https://nextly.example.com through a Cloudflare Tunnel.")
                .font(Theme.small).foregroundStyle(.secondary)
            Labeled("Server address") {
                TextField("Server address", text: $url, prompt: Text("https://nextly.example.com"))
                    .plainURLField()
            }
            if !urlOk { Text("The address should start with http:// or https://.").errorStyle() }
            Labeled("Second address (optional)") {
                TextField("Second address (optional)", text: $altUrl, prompt: Text("https://nextly.your-tailnet.ts.net"))
                    .plainURLField()
            }
            Text("Another way to reach the same server, such as Tailscale. Nextly uses whichever address answers and switches if one stops working.")
                .font(Theme.small).foregroundStyle(.secondary)
            if !altOk { Text(url.trimmingCharacters(in: .whitespaces).isEmpty ? "Fill in the server address first." : "The address should start with http:// or https://.").errorStyle() }
            Labeled("Sync token") {
                SecureField("Sync token", text: $token, prompt: Text("NEXTLY_TOKEN from the server’s .env"))
            }
        } header: {
            Text("Sync")
        }

        Section {
            Text("Sent with every sync and file request. For Cloudflare Access, add your service token’s Client ID and Client Secret.")
                .font(Theme.small).foregroundStyle(.secondary)
            ForEach(headers.indices, id: \.self) { i in
                HStack {
                    TextField("Header name", text: $headers[i].name).plainURLField()
                    if headers[i].name.range(of: "secret|token|key|password", options: [.regularExpression, .caseInsensitive]) != nil {
                        SecureField("Value", text: $headers[i].value)
                    } else {
                        TextField("Value", text: $headers[i].value).plainURLField()
                    }
                    Button { headers.remove(at: i) } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(headers[i].name.nonEmpty ?? "header")")
                }
            }
            HStack {
                Button("Add header") { headers.append(.init(name: "", value: "")) }
                if !hasAccess {
                    Button("Add Cloudflare Access headers") {
                        headers += [.init(name: "CF-Access-Client-Id", value: ""), .init(name: "CF-Access-Client-Secret", value: "")]
                    }
                }
            }
            .buttonStyle(.borderless)
            if let headerError { Text(headerError).errorStyle() }
        } header: {
            Text("Request headers")
        }

        Section {
            // Side by side when they fit; stacked on a phone.
            ViewThatFits(in: .horizontal) {
                HStack { syncButtons(urlOk: urlOk, altOk: altOk, headerError: headerError) }
                VStack(alignment: .leading) { syncButtons(urlOk: urlOk, altOk: altOk, headerError: headerError) }
            }
            .buttonStyle(.bordered)
            if let diag {
                VStack(alignment: .leading, spacing: 4) { ForEach(diag.lines, id: \.self) { Text($0) } }
                    .font(Theme.small)
                    .foregroundStyle(diag.ok ? Color.primary : Theme.danger)
            }
            statusLine(sync.status.state.rawValue, syncLine)
            statusLine(liveDot, liveLine)
            Text("Nextly \(appVersion) · This device: \(store.deviceId)").font(Theme.small).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func syncButtons(urlOk: Bool, altOk: Bool, headerError: String?) -> some View {
        Button("Save and sync") {
            let s = SyncSettings(url: url, altUrl: altUrl, token: token, headers: headers)
            Task { await sync.saveSettings(s) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!urlOk || !altOk || headerError != nil)
        Button("Sync now") { Task { await sync.syncNow() } }
            .disabled(sync.settings.url.isEmpty)
        Button(checking ? "Checking…" : "Check connection") {
            checking = true
            Task { diag = await sync.checkConnection(); checking = false }
        }
        .disabled(sync.settings.url.isEmpty || checking)
    }

    private var syncLine: String {
        var s = sync.status.message
        if let last = sync.status.lastSync, let d = try? Date(last, strategy: .iso8601) { s += " · last synced \(d.formatted(date: .abbreviated, time: .shortened))" }
        if let via = sync.status.via { s += " · through \(via)" }
        return s
    }

    private var liveDot: String {
        switch sync.status.live {
        case .live: "idle"
        case .retrying: "error"
        case .connecting: "syncing"
        case .off: "off"
        }
    }

    private var liveLine: String {
        let base = switch sync.status.live {
        case .off: "Live updates off"
        case .connecting: "Connecting live updates…"
        case .live: "Live updates on: changes from other devices appear right away"
        case .retrying: "Live updates disconnected"
        }
        return sync.status.liveDetail.isEmpty ? base : "\(base) · \(sync.status.liveDetail)"
    }

    private func statusLine(_ state: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            SyncDot(state: state)
            Text(text).font(Theme.small).foregroundStyle(state == "error" ? Theme.danger : .secondary)
        }
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }

    // MARK: - Incident IQ

    @ViewBuilder private var iiqSection: some View {
        Section("Incident IQ") {
            if case .some(let fetched) = iiq {
                if let s = fetched, s.enabled {
                    iiqStatusLines(s)
                } else {
                    Text("Not set up. Tickets assigned to you can sync into an “Incident IQ” project once the server has your district’s Incident IQ details. See docs/incident-iq.md.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Checking…").foregroundStyle(.secondary)
            }
            WarnNote(title: "Student information.", text: "Ticket tasks can include more than directory information about students, such as names with device problems and ticket descriptions. They’re stored on your Nextly server and devices. Follow district guidance on where student information may be kept.")
        }
    }

    @ViewBuilder private func iiqStatusLines(_ s: IiqStatus) -> some View {
        if let err = s.lastError {
            statusLine("error", err)
        } else if let last = s.lastSync {
            let when = (try? Date(last, strategy: .iso8601))?.formatted(date: .omitted, time: .shortened) ?? last
            let n = s.tickets ?? 0
            statusLine("idle", "\(n) open ticket\(n == 1 ? "" : "s") assigned to you · checked \(when) · every \(Int(((s.pollSeconds ?? 120) / 60).rounded())) min")
        } else {
            statusLine("syncing", "First sync in progress…")
        }
        if s.knowsUser != true {
            Text("The server doesn’t know which Incident IQ user you are, so it can’t pick out your tickets. Set IIQ_USER_EMAIL on the server.")
                .font(Theme.small).foregroundStyle(.secondary)
        }
        Text(s.canResolve == true
             ? "Finishing a ticket’s task resolves the ticket in Incident IQ."
             : "Finishing a ticket’s task adds an internal note; close the ticket in Incident IQ. Set IIQ_RESOLUTION_ACTION_ID on the server to resolve tickets from Nextly.")
            .font(Theme.small).foregroundStyle(.secondary)
    }

    // MARK: - Areas and projects

    @ViewBuilder private var areasSection: some View {
        let v = model.view
        Section {
            Text("Areas group projects in the sidebar, like Classroom or Tech committee.")
                .font(Theme.small).foregroundStyle(.secondary)
            ForEach(v.areas) { a in
                HStack {
                    TextField("Area name", text: Binding(get: { a.title }, set: { store.updateArea(a.id, ["title": .string($0)]) }))
                    Button { store.deleteArea(a.id) } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Delete area \(a.title)")
                }
            }
            HStack {
                TextField("New area", text: $newArea).onSubmit(addArea)
                Button("Add area", action: addArea).disabled(newArea.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        } header: {
            Text("Areas and projects")
        }
        if !v.projects.isEmpty {
            Section("Projects") {
                ForEach(v.projects) { p in
                    HStack {
                        TextField("Project name", text: Binding(get: { p.title }, set: { store.updateProject(p.id, ["title": .string($0)]) }))
                        Picker("Area", selection: Binding(get: { p.areaId }, set: { store.updateProject(p.id, ["areaId": $0.map(JSONValue.string) ?? nil]) })) {
                            Text("No area").tag(String?.none)
                            ForEach(v.areas) { a in Text(a.title).tag(String?.some(a.id)) }
                        }
                        .labelsHidden()
                        .fixedSize()
                        Button { store.deleteProject(p.id) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Delete project \(p.title)")
                            .help("Delete project (its tasks move to Inbox)")
                    }
                }
            }
        }
    }

    private func addArea() {
        let t = newArea.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { _ = store.createArea(t) }
        newArea = ""
    }

    // MARK: - Keyboard

    private var keyboardSection: some View {
        Section("Keyboard") {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                ForEach([("⌘N", "New task"), ("⌘K", "Search"), ("⌘D", "Mark selected task In Progress"), ("⌘T", "Flag selected task Today"),
                         ("⌘⇧T", "Flag selected task Next"), ("⌘↩", "Complete selected task"), ("⌘⌫", "Delete selected task (with Undo)"),
                         ("Esc", "Close details"), ("⌘,", "Settings")], id: \.0) { k in
                    GridRow {
                        Text(k.0).font(.system(.body, design: .monospaced))
                        Text(k.1)
                    }
                }
            }
            Text("In quick add, !t !p !n !s !i set Today, In Progress, Next, Someday or Inbox. @mon holds a task in Scheduled until that day, ^fri sets a deadline, and *daily, *weekdays, *weekly, *monthly or *3d / *2w make it repeat. A pasted Gmail link becomes an email card.")
                .font(Theme.small).foregroundStyle(.secondary)
        }
    }
}

private extension View {
    /// For addresses and header names: no capitals, autocorrect or spellcheck.
    func plainURLField() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
        #else
        self.autocorrectionDisabled()
        #endif
    }
}

private extension Text {
    func errorStyle() -> some View { font(Theme.small).foregroundStyle(Theme.danger) }
}

/// A field with its name above it, so it stays labeled once it's filled in.
private struct Labeled<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Theme.small.weight(.semibold)).foregroundStyle(.secondary)
            content
        }
    }
}
