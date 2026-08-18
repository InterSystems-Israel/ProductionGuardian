/// REST API dispatcher for patient demographics.
/// Accepts POST requests from the PatientDemographicsOperation business operation
/// and upserts the data into ProductionGuardian.LabDemo.Data.PatientRecord.
///
/// URL map (registered in the web application configuration):
///
///   POST /labdemo/patients          — upsert a patient record
///   GET  /labdemo/patients/:id      — retrieve a patient by PatientID
///   GET  /labdemo/patients          — list all patients (paginated, max 100)
///   GET  /labdemo/patients/count    — total record count
///
/// Register this dispatcher under a CSP web application:
///   Management Portal → System Administration → Security → Applications → Web Applications
///   Path: /labdemo  →  Dispatch class: ProductionGuardian.LabDemo.REST.PatientDispatcher
///   Namespace: LABDEMO
Class ProductionGuardian.LabDemo.REST.PatientDispatcher Extends %CSP.REST
{

Parameter CONTENTTYPE = "application/json";

/// All responses are JSON; CORS is open for the demo dashboard.
Parameter HandleCorsRequest = 1;

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
  <Route Url="/patients"        Method="POST" Call="UpsertPatient"/>
  <Route Url="/patients/count"  Method="GET"  Call="GetCount"/>
  <Route Url="/patients/:id"    Method="GET"  Call="GetPatient"/>
  <Route Url="/patients"        Method="GET"  Call="ListPatients"/>
</Routes>
}

// ── POST /patients ────────────────────────────────────────────────────────────

/// Upsert a patient record.
/// Expects a JSON body matching the PatientDemographics message shape:
/// {
///   "PatientID":       "123456",
///   "LastName":        "DOE",
///   "FirstName":       "JOHN",
///   "MiddleName":      "A",
///   "DateOfBirth":     "19800101",
///   "Sex":             "M",
///   "AddressStreet":   "123 MAIN ST",
///   "AddressCity":     "SPRINGFIELD",
///   "AddressState":    "IL",
///   "AddressZip":      "62701",
///   "HomePhone":       "555-555-1234",
///   "SourceMessageID": "MSG202608090001"
/// }
ClassMethod UpsertPatient() As %Status
{
    set sc = $$$OK
    try {
        // DOWNSTREAM THROTTLE -- this is what makes MVP 2's scenario a real bottleneck rather
        // than a staged one.
        //
        // The spec's scenario is: Cloud API runs at PoolSize 1, each message it sends is a POST
        // to this dispatcher, and this dispatcher takes ~1s per call -- so the pipeline is capped
        // at ~1 msg/sec regardless of inbound volume. Raise inbound above that and a queue builds
        // in front of Cloud API. The only correct fix is more workers (pool 1 -> 4), because with
        // several workers the 1s waits OVERLAP and effective throughput rises to ~4/sec.
        //
        // That is why the delay belongs HERE and not in the operation. A `hang` inside
        // PatientDemographicsOperation would serialise per worker and enlarging the pool would
        // still help -- but the story would be "our own code is slow", which is not a bottleneck
        // an operator diagnoses or a pool size fixes in a way that generalises. A slow DOWNSTREAM
        // dependency with a single worker in front of it is the real, common shape.
        //
        // Read from a global at RUNTIME, same as the injected delay in
        // PatientDemographicsOperation (#78): the scenario can be armed and cleared without
        // editing or recompiling this class mid-demo, and Triggers.Reset() clears it. A `hang 1`
        // left in source would throttle every later measurement and poison every baseline
        // captured after it -- and would be invisible in the one place nobody re-reads.
        //
        // Zero by default, so an unarmed instance behaves exactly as it did in MVP 1.
        set throttle = +$get(^ProductionGuardian.Trigger("DispatcherMs"), 0)
        if throttle > 0 { hang (throttle / 1000) }

        // Read and parse the JSON body.
        set body = %request.Content.Read(1000000)
        set dyn = ##class(%DynamicObject).%FromJSON(body)

        set patientID = dyn.PatientID
        if patientID = "" {
            do ..WriteErrorResponse(400, "PatientID is required")
            quit
        }

        // Upsert into the persistent table.
        set sc = ##class(ProductionGuardian.LabDemo.Data.PatientRecord).Upsert(
            patientID,
            dyn.LastName,
            dyn.FirstName,
            dyn.MiddleName,
            dyn.DateOfBirth,
            dyn.Sex,
            dyn.AddressStreet,
            dyn.AddressCity,
            dyn.AddressState,
            dyn.AddressZip,
            dyn.HomePhone,
            dyn.SourceMessageID,
            .rec)

        if $$$ISERR(sc) {
            do ..WriteErrorResponse(500, $system.Status.GetErrorText(sc))
            quit
        }

        // Return 200 with the saved record.
        set %response.Status = "200 OK"
        do ..WriteJSON(..RecordToDynamic(rec))

    } catch ex {
        do ..WriteErrorResponse(500, ex.DisplayString())
        set sc = ex.AsStatus()
    }
    quit sc
}

// ── GET /patients/:id ─────────────────────────────────────────────────────────

/// Retrieve a single patient by PatientID.
ClassMethod GetPatient(pID As %String) As %Status
{
    set rec = ##class(ProductionGuardian.LabDemo.Data.PatientRecord).GetByID(pID)
    if '$isobject(rec) {
        do ..WriteErrorResponse(404, "Patient not found: " _ pID)
        quit $$$OK
    }
    set %response.Status = "200 OK"
    do ..WriteJSON(..RecordToDynamic(rec))
    quit $$$OK
}

// ── GET /patients/count ───────────────────────────────────────────────────────

/// Return total count of patient records.
ClassMethod GetCount() As %Status
{
    set cnt = ##class(ProductionGuardian.LabDemo.Data.PatientRecord).Count()
    set %response.Status = "200 OK"
    do ..WriteJSON({"count": (cnt)})
    quit $$$OK
}

// ── GET /patients ─────────────────────────────────────────────────────────────

/// List patients, paginated. Query params: ?offset=0&limit=50 (max 100).
ClassMethod ListPatients() As %Status
{
    set offset = +$get(%request.Data("offset", 1), 0)
    set limit  = +$get(%request.Data("limit",  1), 50)
    if limit > 100 { set limit = 100 }

    set result = []
    set rs = ##class(%ResultSet).%New("ProductionGuardian.LabDemo.Data.PatientRecord:Extent")
    do rs.Execute()
    set row = 0
    while rs.Next() {
        set row = row + 1
        if row <= offset { continue }
        if (row - offset) > limit { quit }
        set rec = ##class(ProductionGuardian.LabDemo.Data.PatientRecord).%OpenId(rs.Data("ID"))
        if $isobject(rec) { do result.%Push(..RecordToDynamic(rec)) }
    }

    set %response.Status = "200 OK"
    do ..WriteJSON({"patients": (result), "offset": (offset), "limit": (limit)})
    quit $$$OK
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Convert a PatientRecord to a %DynamicObject for JSON serialisation.
ClassMethod RecordToDynamic(rec As ProductionGuardian.LabDemo.Data.PatientRecord) As %DynamicObject [ Private ]
{
    quit {
        "PatientID":         (rec.PatientID),
        "LastName":          (rec.LastName),
        "FirstName":         (rec.FirstName),
        "MiddleName":        (rec.MiddleName),
        "DateOfBirth":       (rec.DateOfBirth),
        "Sex":               (rec.Sex),
        "AddressStreet":     (rec.AddressStreet),
        "AddressCity":       (rec.AddressCity),
        "AddressState":      (rec.AddressState),
        "AddressZip":        (rec.AddressZip),
        "HomePhone":         (rec.HomePhone),
        "LastUpdated":       (rec.LastUpdated),
        "LastSourceMessageID": (rec.LastSourceMessageID),
        "UpdateCount":       (rec.UpdateCount)
    }
}

/// Write a %DynamicObject as the response body.
/// 
/// `%ToJSON()` takes NO argument on purpose: with none it writes to the current device,
/// which inside a %CSP.REST request is the CSP output stream. The obvious-looking
/// `%ToJSON(%response.Output)` fails at runtime — %CSP.Response has no `Output` property
/// on IRIS 2026.1 — so every route through here returned HTTP 500. Verified:
/// `##class(%Dictionary.CompiledProperty).%ExistsId("%CSP.Response||Output")` is 0.
/// It compiles cleanly either way, which is why nothing caught it until an endpoint was
/// actually called (#37).
ClassMethod WriteJSON(dyn As %DynamicObject) [ Private ]
{
    set %response.ContentType = "application/json"
    do dyn.%ToJSON()
}

/// Write a JSON error response.
/// 
/// `write {...}` on a JSON literal emits an OREF, not JSON — measured output was
/// `24616@%Library.DynamicObject`. A dynamic object has to be serialized explicitly;
/// `write` on it stringifies the reference. So error bodies were unparseable even on the
/// paths that did not 500.
ClassMethod WriteErrorResponse(httpStatus As %Integer, message As %String) [ Private ]
{
    set %response.Status = httpStatus _ " Error"
    set %response.ContentType = "application/json"
    set err = {"error": (message)}
    do err.%ToJSON()
}

}
