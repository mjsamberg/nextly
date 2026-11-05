// Port of app/src/store.ts (and db.ts): every record in memory, saved to a
// SQLite file, and queued for sync. The app changes data only through the
// actions here; the rules themselves are in Rules.cs.
//
// Thread-safe: the app's UI and the sync engine both use it. Events fire on
// whichever thread made the change; the app marshals them to its UI thread.

using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Nextly.Core;

public sealed record StoredFile(string Sha, string Name, string Mime, bool Uploaded, byte[] Bytes);

public sealed class LocalStore : IDisposable
{
    readonly SqliteConnection db;
    readonly object gate = new();
    readonly OrderedDictionary<string, Rec> records = new();
    readonly HashSet<string> outbox = [];
    readonly Hlc hlc = new();
    ViewData? cache;

    public string DeviceId { get; }

    /// <summary>Any change, local or from sync (refresh the UI).</summary>
    public event Action? Changed;
    /// <summary>A local edit (sync soon).</summary>
    public event Action? LocalChanged;

    /// <summary>The Incident IQ task waiting for resolution notes, if any.</summary>
    public string? ResolvingId { get; private set; }

    public LocalStore(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open();
        Exec("PRAGMA journal_mode = WAL");
        Exec("""
            CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hlc TEXT NOT NULL, deleted INTEGER NOT NULL, data TEXT);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS files (sha TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, uploaded INTEGER NOT NULL, bytes BLOB NOT NULL);
            """);
        DeviceId = Js.AsString(GetMeta("deviceId")) ?? Logic.Uid()[..8];
        SetMeta("deviceId", DeviceId);
        hlc.Device = DeviceId;
        using (var cmd = Cmd("SELECT id, kind, hlc, deleted, data FROM records ORDER BY rowid"))
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read())
            {
                var rec = new Rec(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3) != 0, r.IsDBNull(4) ? null : JsonNode.Parse(r.GetString(4)));
                records[rec.Id] = rec;
                hlc.Observe(rec.Hlc);
            }
        }
        using (var cmd = Cmd("SELECT id FROM outbox"))
        using (var r = cmd.ExecuteReader())
            while (r.Read()) outbox.Add(r.GetString(0));
    }

    public void Dispose() => db.Dispose();

    // ---------- SQLite ----------

    SqliteTransaction? tx;

    /// <summary>Groups several writes into one transaction (call under the lock).</summary>
    SqliteTransaction Begin() => tx = db.BeginTransaction();

    void Commit(SqliteTransaction t)
    {
        t.Commit();
        tx = null;
    }

    SqliteCommand Cmd(string sql, params (string, object?)[] args)
    {
        var c = db.CreateCommand();
        c.Transaction = tx?.Connection is null ? null : tx; // a finished or rolled-back one has no connection
        c.CommandText = sql;
        foreach (var (k, v) in args) c.Parameters.AddWithValue(k, v ?? DBNull.Value);
        return c;
    }

    void Exec(string sql, params (string, object?)[] args)
    {
        using var c = Cmd(sql, args);
        c.ExecuteNonQuery();
    }

    void Persist(Rec r) => Exec("INSERT INTO records (id, kind, hlc, deleted, data) VALUES ($id, $kind, $hlc, $deleted, $data) " +
        "ON CONFLICT(id) DO UPDATE SET kind = $kind, hlc = $hlc, deleted = $deleted, data = $data",
        ("$id", r.Id), ("$kind", r.Kind), ("$hlc", r.Hlc), ("$deleted", r.Deleted ? 1 : 0), ("$data", r.Data is null ? null : Js.Json(r.Data)));

    public JsonNode? GetMeta(string key)
    {
        lock (gate)
        {
            using var c = Cmd("SELECT value FROM meta WHERE key = $k", ("$k", key));
            return c.ExecuteScalar() is string s ? JsonNode.Parse(s) : null;
        }
    }

    public void SetMeta(string key, JsonNode? value)
    {
        lock (gate) Exec("INSERT INTO meta (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v", ("$k", key), ("$v", Js.Json(value)));
    }

    // ---------- reading ----------

    /// <summary>A snapshot of every record.</summary>
    public List<Rec> AllRecords() { lock (gate) return records.Values.ToList(); }

    public Rec? Record(string id) { lock (gate) return records.GetValueOrDefault(id); }

    /// <summary>The derived view every list is built from, rebuilt once per change.</summary>
    public ViewData View
    {
        get { lock (gate) return cache ??= Rules.BuildView(records.Values.ToList()); }
    }

    void Notify(bool local)
    {
        Changed?.Invoke();
        if (local) LocalChanged?.Invoke();
    }

    // ---------- writing ----------

    /// <summary>Saves a record, stamped with the format this app writes (Schema.Current).</summary>
    void Write(string kind, string id, JsonNode? data, bool deleted)
    {
        if (data is JsonObject o) { o = (JsonObject)o.DeepClone(); o["schema"] = Schema.Current; data = o; }
        var rec = new Rec(id, kind, hlc.Now(), deleted, data);
        records[id] = rec;
        outbox.Add(id);
        cache = null;
        Persist(rec);
        Exec("INSERT OR IGNORE INTO outbox (id) VALUES ($id)", ("$id", id));
    }

    /// <summary>Applies rows from the server. Returns how many were newer than ours.</summary>
    public int ApplyRemote(IEnumerable<Rec> rows)
    {
        var changed = 0;
        lock (gate)
        {
            using var t = Begin();
            foreach (var rec in rows)
            {
                hlc.Observe(rec.Hlc);
                if (records.TryGetValue(rec.Id, out var cur) && Js.Cmp(cur.Hlc, rec.Hlc) >= 0) continue;
                records[rec.Id] = rec;
                Persist(rec);
                changed++;
            }
            Commit(t);
            if (changed > 0) cache = null;
        }
        if (changed > 0) Notify(false);
        return changed;
    }

    /// <summary>Queues every local record to be sent again, for a server that lost its data.</summary>
    public void RequeueAll()
    {
        lock (gate)
        {
            using var t = Begin();
            foreach (var id in records.Keys) if (outbox.Add(id)) Exec("INSERT OR IGNORE INTO outbox (id) VALUES ($id)", ("$id", id));
            Commit(t);
        }
    }

    public (int Records, int Tasks, int Unsent) LocalCounts()
    {
        lock (gate) return (records.Count, records.Values.Count((r) => r.Kind == "task" && !r.Deleted), outbox.Count);
    }

    public List<Rec> PendingChanges()
    {
        lock (gate) return outbox.Select((id) => records.GetValueOrDefault(id)).Where((r) => r is not null).Select((r) => r!).ToList();
    }

    public void MarkSent(IEnumerable<Rec> sent)
    {
        lock (gate)
        {
            foreach (var r in sent)
            {
                if (records.GetValueOrDefault(r.Id)?.Hlc != r.Hlc) continue; // edited again while in flight
                outbox.Remove(r.Id);
                Exec("DELETE FROM outbox WHERE id = $id", ("$id", r.Id));
            }
        }
    }

    // ---------- attachments ----------

    public StoredFile? File(string sha)
    {
        lock (gate)
        {
            using var c = Cmd("SELECT sha, name, mime, uploaded, bytes FROM files WHERE sha = $s", ("$s", sha));
            using var r = c.ExecuteReader();
            return r.Read() ? new StoredFile(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3) != 0, (byte[])r["bytes"]) : null;
        }
    }

    public void PutFile(StoredFile f)
    {
        lock (gate) Exec("INSERT INTO files (sha, name, mime, uploaded, bytes) VALUES ($s, $n, $m, $u, $b) " +
            "ON CONFLICT(sha) DO UPDATE SET name = $n, mime = $m, uploaded = $u, bytes = $b",
            ("$s", f.Sha), ("$n", f.Name), ("$m", f.Mime), ("$u", f.Uploaded ? 1 : 0), ("$b", f.Bytes));
    }

    public List<string> UnsentFiles()
    {
        lock (gate)
        {
            using var c = Cmd("SELECT sha FROM files WHERE uploaded = 0 ORDER BY sha");
            using var r = c.ExecuteReader();
            var outp = new List<string>();
            while (r.Read()) outp.Add(r.GetString(0));
            return outp;
        }
    }

    public void MarkFileUploaded(string sha, bool uploaded = true)
    {
        lock (gate) Exec("UPDATE files SET uploaded = $u WHERE sha = $s", ("$u", uploaded ? 1 : 0), ("$s", sha));
    }

    /// <summary>For a server that lost its data: send every file again.</summary>
    public void MarkAllFilesUnsent() { lock (gate) Exec("UPDATE files SET uploaded = 0"); }

    // ---------- actions: run a rule, then save what it changed ----------

    T Run<T>(Func<Draft, T> rule)
    {
        T result;
        int changes;
        lock (gate)
        {
            var now = DateTimeOffset.Now;
            var d = new Draft(records, new Ctx(now, Logic.Ymd(DateOnly.FromDateTime(now.LocalDateTime)), Logic.Uid));
            result = rule(d);
            changes = d.Changes.Count;
            if (changes > 0)
            {
                using var t = Begin();
                foreach (var c in d.Changes.Values) Write(c.Kind, c.Id, c.Data, c.Deleted);
                Commit(t);
            }
        }
        if (changes > 0) Notify(true);
        return result;
    }

    void Run(Action<Draft> rule) => Run((d) => { rule(d); return 0; });

    public string CreateTask(JsonObject task) => Run((d) => Rules.CreateTask(d, task));
    public void UpdateTask(string id, JsonObject patch) => Run((d) => Rules.UpdateTask(d, id, patch));
    public void SetFlag(string id, string? flag) => Run((d) => Rules.SetFlag(d, id, flag));
    public void QueueIiq(string taskId, string type, string? text = null) => Run((d) => Rules.QueueIiq(d, taskId, type, text));
    public void SetNotes(string id, JsonArray notes) => UpdateTask(id, new JsonObject { ["notes"] = notes });
    public void SetStartOn(string id, string? startOn) => Run((d) => Rules.SetStartOn(d, id, startOn));
    public void PromoteDue() => Run(Rules.PromoteDue);
    public string? AddDependency(string id, string depId) => Run((d) => Rules.AddDependency(d, id, depId));
    public void RemoveDependency(string id, string depId) => Run((d) => Rules.RemoveDependency(d, id, depId));
    public void MoveInNext(string id, string? beforeId) => Run((d) => Rules.MoveInNext(d, id, beforeId));

    /// <summary>Completing an open Incident IQ ticket's task asks for notes first (ResolvingId).</summary>
    public void ToggleDone(string id)
    {
        if (Run((d) => Rules.ToggleDone(d, id)) == "needs-notes") { ResolvingId = id; Notify(false); }
    }

    public void ResolveWithNotes(string id, string notes, string? resolutionActionId = null)
    {
        ResolvingId = null;
        Run((d) => Rules.ResolveWithNotes(d, id, notes, resolutionActionId));
    }

    public void CancelResolve()
    {
        ResolvingId = null;
        Notify(false);
    }

    /// <summary>Soft-deletes a task and its subtasks. Returns an action that undoes it.</summary>
    public Action DeleteTask(string id)
    {
        var deleted = Run((d) => { Rules.DeleteTask(d, id); return d.Changes.Values.ToList(); });
        return () =>
        {
            lock (gate)
            {
                using var t = Begin();
                foreach (var c in deleted) Write("task", c.Id, c.Data, false);
                Commit(t);
            }
            Notify(true);
        };
    }

    public string CreateProject(string title, string? areaId) => Run((d) => Rules.CreateProject(d, title, areaId));
    public void UpdateProject(string id, JsonObject patch) => Run((d) => Rules.UpdateProject(d, id, patch));
    public void DeleteProject(string id) => Run((d) => Rules.DeleteProject(d, id));
    public string CreateArea(string title) => Run((d) => Rules.CreateArea(d, title));
    public void UpdateArea(string id, JsonObject patch) => Run((d) => Rules.UpdateArea(d, id, patch));
    public void DeleteArea(string id) => Run((d) => Rules.DeleteArea(d, id));
}
