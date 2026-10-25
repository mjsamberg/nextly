// Records as they sync (spec/protocol.md), and typed views of them for the
// lists and the app. The view types read the JSON; saving always goes back
// through the JSON, so fields this app doesn't know survive.

using System.Text.Json.Nodes;

namespace Nextly.Core;

/// <summary>The unit of sync. Matches the rows the server stores.</summary>
public sealed record Rec(string Id, string Kind, string Hlc, bool Deleted, JsonNode? Data);

/// <summary>A task, normalized (Logic.NormTask), with its id.</summary>
public sealed class TaskItem
{
    public string Id { get; }
    /// <summary>The normalized data, including fields this app doesn't know.</summary>
    public JsonObject Data { get; }
    /// <summary>Saved by a newer Nextly (a higher schema), so shown but not changed here.</summary>
    public bool ReadOnly { get; }

    public TaskItem(string id, JsonObject normalized, bool readOnly = false)
    {
        Id = id;
        Data = normalized;
        ReadOnly = readOnly;
        DependsOn = (Data["dependsOn"] as JsonArray)?.Select((x) => Js.AsString(x) ?? "").ToList() ?? [];
        Notes = (Data["notes"] as JsonArray)?.Select((x) => x as JsonObject ?? new JsonObject()).ToList() ?? [];
        Repeat = RepeatRule.Parse(Data["repeat"]);
    }

    public string Title => Js.AsString(Data["title"]) ?? "";
    public string? Flag => Js.AsString(Data["flag"]);
    /// <summary>The project id when it's text (anything else matches no project).</summary>
    public string? ProjectId => Js.AsString(Data["projectId"]);
    public bool HasProject => Js.Truthy(Data["projectId"]);
    public string? ParentId => Js.AsString(Data["parentId"]);
    public bool HasParent => Js.Truthy(Data["parentId"]);
    public string? Deadline => Js.AsString(Data["deadline"]);
    public string? StartOn => Js.AsString(Data["startOn"]);
    public RepeatRule? Repeat { get; }
    public string? NextId => Js.AsString(Data["nextId"]);
    public JsonObject? External => Data["external"] as JsonObject;
    public bool Done => Js.Truthy(Data["done"]);
    /// <summary>`doneAt ?? ''` as text, for sorting the Logbook.</summary>
    public string DoneAt => Data["doneAt"] is { } d ? Js.Str(d) : "";
    public double Order => Js.IsNumber(Data["order"], out var n) ? n : 0;
    public IReadOnlyList<string> DependsOn { get; }
    public IReadOnlyList<JsonObject> Notes { get; }
    public string CreatedAt => Data["createdAt"] is { } c ? Js.Str(c) : "";

    public bool IsTicket => Js.AsString(External?["source"]) == "iiq";
    /// <summary>An Incident IQ ticket that's still open there.</summary>
    public bool IsOpenTicket => IsTicket && !Js.Truthy(External!["closed"]);
    public string? TicketCreated => External?["created"] is { } c && Js.Truthy(c) ? Js.Str(c) : null;
}

public sealed class ProjectItem
{
    public string Id { get; }
    public JsonObject Data { get; }
    public bool ReadOnly { get; }

    public ProjectItem(string id, JsonObject data, bool readOnly = false) { Id = id; Data = data; ReadOnly = readOnly; }

    public string Title => Data["title"] is { } t && Js.Truthy(t) ? Js.Str(t) : "";
    public string? AreaId => Js.AsString(Data["areaId"]);
    public bool HasArea => Js.Truthy(Data["areaId"]);
    /// <summary>NaN when it isn't a number (sorts as "equal").</summary>
    public double Order => Js.IsNumber(Data["order"], out var n) ? n : double.NaN;
}

public sealed class AreaItem
{
    public string Id { get; }
    public JsonObject Data { get; }
    public bool ReadOnly { get; }

    public AreaItem(string id, JsonObject data, bool readOnly = false) { Id = id; Data = data; ReadOnly = readOnly; }

    public string Title => Data["title"] is { } t && Js.Truthy(t) ? Js.Str(t) : "";
    public double Order => Js.IsNumber(Data["order"], out var n) ? n : double.NaN;
}

/// <summary>A request for the server to carry out in Incident IQ, and its result.</summary>
public sealed class IiqActionItem
{
    public string Id { get; }
    public JsonObject Data { get; }

    public IiqActionItem(string id, JsonObject data) { Id = id; Data = data; }

    public string Type => Js.AsString(Data["type"]) ?? "";
    public string TaskId => Data["taskId"] is { } t ? Js.Str(t) : "";
    public string State => Js.AsString(Data["state"]) ?? "";
    public string? Message => Js.AsString(Data["message"]);
    public string? Text => Js.AsString(Data["text"]);
    public string CreatedAt => Data["createdAt"] is { } c ? Js.Str(c) : "";
}
