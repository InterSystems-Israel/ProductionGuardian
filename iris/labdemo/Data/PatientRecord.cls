/// Persistent patient demographics table.
/// Keyed on PatientID — insert on first encounter, update on subsequent ones.
///
/// Access via:
///   ##class(ProductionGuardian.LabDemo.Data.PatientRecord).Upsert(demographics)
///   ##class(ProductionGuardian.LabDemo.Data.PatientRecord).GetByID("123456")
///
/// Browse in Management Portal: System Explorer → SQL → LABDEMO
///   SELECT * FROM ProductionGuardian_LabDemo_Data.PatientRecord
Class ProductionGuardian.LabDemo.Data.PatientRecord Extends %Persistent
{

/// Business-key: the patient MR number from PID-3.
/// Indexed for fast lookup by the REST dispatcher.
Property PatientID As %String(MAXLEN = 64) [ Required ];

Property LastName As %String(MAXLEN = 128);
Property FirstName As %String(MAXLEN = 128);
Property MiddleName As %String(MAXLEN = 64);

/// YYYYMMDD format as received from HL7 PID-7.
Property DateOfBirth As %String(MAXLEN = 8);

/// M / F / O / U
Property Sex As %String(MAXLEN = 1);

Property AddressStreet As %String(MAXLEN = 256);
Property AddressCity As %String(MAXLEN = 128);
Property AddressState As %String(MAXLEN = 64);
Property AddressZip As %String(MAXLEN = 16);
Property HomePhone As %String(MAXLEN = 32);

/// ISO 8601 timestamp of the last update.
Property LastUpdated As %String(MAXLEN = 32);

/// HL7 message control ID of the last message that updated this record.
Property LastSourceMessageID As %String(MAXLEN = 64);

/// Number of times this record has been updated (1 on first insert).
Property UpdateCount As %Integer [ InitialExpression = 0 ];

Index PatientIDIndex On PatientID [ Unique ];

/// Insert a new record or update an existing one, keyed on PatientID.
/// Returns $$$OK on success; sets pRecord to the saved object.
ClassMethod Upsert(
    pPatientID As %String,
    pLastName As %String,
    pFirstName As %String,
    pMiddleName As %String,
    pDOB As %String,
    pSex As %String,
    pStreet As %String,
    pCity As %String,
    pState As %String,
    pZip As %String,
    pPhone As %String,
    pSourceMsgID As %String,
    Output pRecord As ProductionGuardian.LabDemo.Data.PatientRecord) As %Status
{
    // Look up existing record by PatientID unique index.
    set rec = ..PatientIDIndexOpen(pPatientID, -1)  // -1 = no lock
    if '$isobject(rec) {
        // First encounter — create new record.
        set rec = ..%New()
        set rec.PatientID = pPatientID
        set rec.UpdateCount = 0
    }

    // Apply all incoming fields (update wins over whatever was stored before).
    set rec.LastName          = pLastName
    set rec.FirstName         = pFirstName
    set rec.MiddleName        = pMiddleName
    set rec.DateOfBirth       = pDOB
    set rec.Sex               = pSex
    set rec.AddressStreet     = pStreet
    set rec.AddressCity       = pCity
    set rec.AddressState      = pState
    set rec.AddressZip        = pZip
    set rec.HomePhone         = pPhone
    set rec.LastSourceMessageID = pSourceMsgID
    set rec.LastUpdated       = $zdatetime($ztimestamp, 3, 1)
    set rec.UpdateCount       = rec.UpdateCount + 1

    set sc = rec.%Save()
    set pRecord = rec
    quit sc
}

/// Open a PatientRecord by PatientID (returns "" if not found).
ClassMethod GetByID(pPatientID As %String) As ProductionGuardian.LabDemo.Data.PatientRecord
{
    quit ..PatientIDIndexOpen(pPatientID, -1)
}

/// Return a simple summary count for quick health checks.
ClassMethod Count() As %Integer
{
    &sql(SELECT COUNT(*) INTO :cnt FROM ProductionGuardian_LabDemo_Data.PatientRecord)
    quit $get(cnt, 0)
}

Storage Default
{
<Data name="PatientRecordDefaultData">
<Value name="1">
<Value>%%CLASSNAME</Value>
</Value>
<Value name="2">
<Value>PatientID</Value>
</Value>
<Value name="3">
<Value>LastName</Value>
</Value>
<Value name="4">
<Value>FirstName</Value>
</Value>
<Value name="5">
<Value>MiddleName</Value>
</Value>
<Value name="6">
<Value>DateOfBirth</Value>
</Value>
<Value name="7">
<Value>Sex</Value>
</Value>
<Value name="8">
<Value>AddressStreet</Value>
</Value>
<Value name="9">
<Value>AddressCity</Value>
</Value>
<Value name="10">
<Value>AddressState</Value>
</Value>
<Value name="11">
<Value>AddressZip</Value>
</Value>
<Value name="12">
<Value>HomePhone</Value>
</Value>
<Value name="13">
<Value>LastUpdated</Value>
</Value>
<Value name="14">
<Value>LastSourceMessageID</Value>
</Value>
<Value name="15">
<Value>UpdateCount</Value>
</Value>
</Data>
<DataLocation>^PG.LabDemo.PatientRecordD</DataLocation>
<DefaultData>PatientRecordDefaultData</DefaultData>
<IdLocation>^PG.LabDemo.PatientRecordI</IdLocation>
<IndexLocation>^PG.LabDemo.PatientRecordX</IndexLocation>
<StreamLocation>^PG.LabDemo.PatientRecordS</StreamLocation>
<Type>%Storage.Persistent</Type>
</Storage>

}
