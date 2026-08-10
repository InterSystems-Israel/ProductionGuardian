/// Business Process: apply the HL7ToPID DTL transform and forward the result
/// to the PatientDemographicsOperation business operation.
///
/// This replaces the old FHIRTransform routing engine in the production.
/// It handles both ADT^A01 and ORU^R01 — both carry a PID segment.
///
/// Pipeline position:
///   LabRouter → PIDExtractProcess → PatientDemographicsOperation
Class ProductionGuardian.LabDemo.Process.PIDExtractProcess Extends Ens.BusinessProcess [ ClassType = persistent ]
{

Parameter SETTINGS = "TargetOperation:Basic";

/// Name of the business operation to forward the extracted demographics to.
Property TargetOperation As %String [ InitialExpression = "PatientDemographicsOperation" ];

/// Entry point: receive an HL7 message, apply the DTL, send the result.
Method OnRequest(
    pRequest As EnsLib.HL7.Message,
    Output pResponse As Ens.Response) As %Status
{
    set sc = $$$OK
    try {
        // Validate we have a PID segment — skip messages that don't carry patient info.
        set pidSegment = pRequest.GetSegmentAt("PID", 1, .scGet)
        if $$$ISERR(scGet) || '$isobject(pidSegment) {
            $$$LOGINFO("PIDExtractProcess: no PID segment in " _ pRequest.Name _ " — skipped")
            set pResponse = ##class(Ens.Response).%New()
            quit
        }

        // Apply the HL7ToPID DTL transform.
        set sc = ##class(Ens.DTL.Transform).ApplyTransform(
            "ProductionGuardian.LabDemo.Transform.HL7ToPID",
            pRequest,
            .demographics)
        if $$$ISERR(sc) {
            $$$LOGERROR("PIDExtractProcess: DTL transform failed — " _ $system.Status.GetErrorText(sc))
            quit
        }

        // Reject records with no PatientID — nothing meaningful to store.
        if demographics.PatientID = "" {
            $$$LOGWARNING("PIDExtractProcess: empty PatientID after transform for msg "
                          _ pRequest.GetValueAt("MSH:10") _ " — skipped")
            set pResponse = ##class(Ens.Response).%New()
            quit
        }

        // Forward to the operation (async — fire and forget for throughput).
        set sc = ..SendRequestAsync(..TargetOperation, demographics)
        if $$$ISERR(sc) quit

        $$$LOGINFO("PIDExtractProcess: forwarded PatientID=" _ demographics.PatientID
                   _ " from " _ pRequest.GetValueAt("MSH:10"))

        set pResponse = ##class(Ens.Response).%New()

    } catch ex {
        set sc = ex.AsStatus()
        $$$LOGERROR("PIDExtractProcess: exception — " _ ex.DisplayString())
    }
    quit sc
}

Method OnResponse(
    pRequest As %Library.Persistent,
    ByRef pResponse As %Library.Persistent,
    pCallRequest As %Library.Persistent,
    pCallResponse As %Library.Persistent,
    pCompletionKey As %String) As %Status
{
    quit $$$OK
}

Storage Default
{
<Data name="PIDExtractProcessDefaultData">
<Subscript>"PIDExtractProcess"</Subscript>
<Value name="1">
<Value>TargetOperation</Value>
</Value>
</Data>
<DefaultData>PIDExtractProcessDefaultData</DefaultData>
<Type>%Storage.Persistent</Type>
</Storage>

}
