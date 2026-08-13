/// Business Operation: POST patient demographics to the REST dispatcher.
///
/// Receives a ProductionGuardian.LabDemo.Message.PatientDemographics request,
/// serialises it to JSON, and HTTP-POSTs it to the PatientDispatcher REST API.
///
/// Configuration settings (set in the production or Management Portal):
///   HTTPServer   — hostname of the REST dispatcher (default: 127.0.0.1)
///   HTTPPort     — port (default: 52773, the IRIS web server port)
///   URL          — base path (default: /labdemo/patients)
///
/// The dispatcher runs in the same IRIS instance, so the default settings
/// point to localhost and use the same web server.
Class ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation Extends Ens.BusinessOperation
{

Parameter ADAPTER = "EnsLib.HTTP.OutboundAdapter";

Parameter INVOCATION = "Queue";

/// HTTP adapter — surfaced here so the Management Portal shows them.
Property Adapter As EnsLib.HTTP.OutboundAdapter;

/// Handle a PatientDemographics request: serialise to JSON and POST.
Method OnMessage(
    pRequest As ProductionGuardian.LabDemo.Message.PatientDemographics,
    Output pResponse As Ens.StringResponse) As %Status
{
    set sc = $$$OK
    // Ens.StringResponse, matching the signature above -- NOT Ens.Response, which has no
    // StringValue property. The mismatch compiled fine and failed only at runtime, on the
    // `set pResponse.StringValue=str` lines below:
    //   ERROR <Ens>ErrException: <PROPERTY DOES NOT EXIST> *StringValue
    // The upsert had already succeeded, so a record landed AND the operation reported an
    // error -- Cloud API sat in Error with messageCount 0 while patients/count rose. Found
    // on the #34 deploy; same runtime-only class as #37, which is exactly what the
    // iris-compile CI job is documented as NOT catching.
    set pResponse = ##class(Ens.StringResponse).%New()

    // Injected processing delay, for the slow_processing / growing_queue_wait triggers.
    // Read from a global at RUNTIME so Triggers.cls can set it without editing or
    // recompiling this class -- README.md used to say "add `hang 1` to the top of
    // OnMessage, recompile", which is a live source edit mid-demo and, worse, a `hang`
    // left behind poisons every later baseline. A global cannot be forgotten in source
    // control and Triggers.Reset() clears it.
    //
    // Zero by default, so this costs nothing when no trigger is armed.
    set delay = +$get(^ProductionGuardian.Trigger("SlowMs"), 0)
    if delay > 0 { hang (delay / 1000) }

    try {
        // Build the JSON payload from the request message.
        set payload = {
            "PatientID":       (pRequest.PatientID),
            "LastName":        (pRequest.LastName),
            "FirstName":       (pRequest.FirstName),
            "MiddleName":      (pRequest.MiddleName),
            "DateOfBirth":     (pRequest.DateOfBirth),
            "Sex":             (pRequest.Sex),
            "AddressStreet":   (pRequest.AddressStreet),
            "AddressCity":     (pRequest.AddressCity),
            "AddressState":    (pRequest.AddressState),
            "AddressZip":      (pRequest.AddressZip),
            "HomePhone":       (pRequest.HomePhone),
            "SourceMessageID": (pRequest.SourceMessageID),
            "ExtractedAt":     (pRequest.ExtractedAt)
        }

        // Write JSON to a stream for the HTTP adapter.
        set stream = ##class(%Stream.TmpCharacter).%New()
        do payload.%ToJSON(stream)
        do stream.Rewind()

        // Build the HTTP request object.
        set httpReq = ##class(%Net.HttpRequest).%New()
        set httpReq.ContentType = "application/json"
        do httpReq.EntityBody.CopyFrom(stream)

        // POST via the adapter (handles retries, error logging, keepalive).
        set sc = ..Adapter.SendFormDataArray(.httpResp, "POST", httpReq, , , )
        if $$$ISERR(sc) quit

        // Log a non-200 HTTP response as a warning but don't fail — the
        // production will show it in the message log without stopping flow.
        if $isobject(httpResp) && (httpResp.StatusCode '= 200) {
            set str="PatientDemographicsOperation: HTTP " _ httpResp.StatusCode _ " for PatientID=" _ pRequest.PatientID            
            $$$LOGWARNING(str)
        } else {
            set str="PatientDemographicsOperation: upserted PatientID=" _ pRequest.PatientID
            $$$LOGINFO(str)
        }
        set pResponse.StringValue=str

    } catch ex {
        set sc = ex.AsStatus()
        set str="PatientDemographicsOperation exception: " _ ex.DisplayString()        
        $$$LOGERROR(str)
        set pResponse.StringValue=str
    }
    quit sc
}

}
