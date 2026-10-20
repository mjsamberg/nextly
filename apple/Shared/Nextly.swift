// Shared by the widget and Siri extensions. They don't run the app's sync
// engine; they read the app's sync settings from the App Group folder and
// call the server's small task API (server/tasks.js) directly.

import AppIntents
import Foundation

// MARK: - App Group

enum AppGroup {
    /// Set per platform in the extension's Info.plist (NextlyAppGroup).
    static var id: String {
        Bundle.main.object(forInfoDictionaryKey: "NextlyAppGroup") as? String ?? "group.com.mjsamberg.nextly"
    }

    static var folder: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
    }

    static func read<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        guard let url = folder?.appendingPathComponent(name), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func write<T: Encodable>(_ value: T, to name: String) {
        guard let url = folder?.appendingPathComponent(name), let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

// MARK: - Models

struct SyncConfig: Codable {
    var url: String
    var token: String
    var headers: [String: String]
}

struct WidgetTask: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let flag: String?
    let deadline: String?
    let blocked: Bool
    let project: String?
}

struct WidgetCounts: Codable, Hashable {
    let today: Int
    let next: Int
    let inbox: Int
}

struct WidgetData: Codable, Hashable {
    let today: [WidgetTask]
    let next: [WidgetTask]
    let counts: WidgetCounts
    let updatedAt: String?

    static let empty = WidgetData(today: [], next: [], counts: WidgetCounts(today: 0, next: 0, inbox: 0), updatedAt: nil)

    static let sample = WidgetData(
        today: [
            WidgetTask(id: "1", title: "Reply to Ms. Ortiz", flag: "today", deadline: nil, blocked: false, project: "Conferences"),
            WidgetTask(id: "2", title: "Grade exit tickets", flag: "today", deadline: nil, blocked: false, project: "Unit 3"),
            WidgetTask(id: "3", title: "Submit Chromebook order", flag: "today", deadline: nil, blocked: true, project: nil),
        ],
        next: [
            WidgetTask(id: "4", title: "Draft newsletter blurb", flag: "next", deadline: nil, blocked: false, project: nil),
            WidgetTask(id: "5", title: "Book the library", flag: "next", deadline: nil, blocked: false, project: nil),
        ],
        counts: WidgetCounts(today: 3, next: 2, inbox: 1),
        updatedAt: nil
    )
}

/// A task Siri couldn't send; the app adds these the next time it opens.
struct PendingTask: Codable {
    let title: String
    let list: String
    let createdAt: String
}

// MARK: - Lists

enum NextlyList: String, AppEnum {
    case today, next, inbox, someday

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "List")
    static var caseDisplayRepresentations: [NextlyList: DisplayRepresentation] = [
        .today: "Today",
        .next: "Next",
        .inbox: "Inbox",
        .someday: "Someday",
    ]

    var label: String {
        switch self {
        case .today: return "Today"
        case .next: return "Next"
        case .inbox: return "Inbox"
        case .someday: return "Someday"
        }
    }
}

// MARK: - Server

enum NextlyError: LocalizedError {
    case notSetUp
    case message(String)

    var errorDescription: String? {
        switch self {
        case .notSetUp: return "Open Nextly and set up sync in Settings first."
        case .message(let m): return m
        }
    }
}

enum AddOutcome { case added, savedForLater }

enum NextlyAPI {
    static var config: SyncConfig? {
        guard let c = AppGroup.read("config.json", as: SyncConfig.self), !c.url.isEmpty, !c.token.isEmpty else { return nil }
        return c
    }

    static func request(_ path: String, method: String = "GET", json: [String: Any]? = nil) async throws -> Data {
        guard let c = config else { throw NextlyError.notSetUp }
        let base = c.url.hasSuffix("/") ? String(c.url.dropLast()) : c.url
        guard let url = URL(string: base + path) else { throw NextlyError.message("The server address in Nextly’s Settings isn’t valid.") }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = method
        for (name, value) in c.headers { req.setValue(value, forHTTPHeaderField: name) }
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "Authorization")
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw NextlyError.message("The server didn’t answer.") }
        let type = http.value(forHTTPHeaderField: "Content-Type") ?? ""
        if http.statusCode == 401 { throw NextlyError.message("The server rejected the sync token. Check it in Nextly’s Settings.") }
        if http.statusCode == 403 || type.contains("text/html") || (http.url?.host ?? "").hasSuffix("cloudflareaccess.com") {
            throw NextlyError.message("Cloudflare Access blocked the request. Check the headers in Nextly’s Settings.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw NextlyError.message(msg ?? "The server answered \(http.statusCode).")
        }
        return data
    }

    /// Fresh lists from the server, falling back to the app's last snapshot.
    static func lists() async -> (WidgetData, fresh: Bool) {
        do {
            let data = try await request("/widget")
            let lists = try JSONDecoder().decode(WidgetData.self, from: data)
            AppGroup.write(lists, to: "snapshot.json")
            return (lists, true)
        } catch {
            return (AppGroup.read("snapshot.json", as: WidgetData.self) ?? .empty, false)
        }
    }

    static func addTask(title: String, list: NextlyList) async throws -> AddOutcome {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw NextlyError.message("The task needs a title.") }
        do {
            _ = try await request("/tasks", method: "POST", json: ["title": clean, "list": list.rawValue])
            return .added
        } catch is URLError {
            // Offline or server unreachable: keep it for the app to add later.
            var pending = AppGroup.read("pending.json", as: [PendingTask].self) ?? []
            pending.append(PendingTask(title: clean, list: list.rawValue, createdAt: ISO8601DateFormatter().string(from: Date())))
            AppGroup.write(pending, to: "pending.json")
            return .savedForLater
        }
    }

    static func complete(taskId: String) async throws {
        _ = try await request("/tasks/\(taskId)/done", method: "POST")
    }
}
