/// Patient demographics message extracted from HL7 v2 PID segment.
/// Used as the request body passed from the DTL transform to the
/// PatientDemographicsOperation business operation.
Class ProductionGuardian.LabDemo.Message.PatientDemographics Extends Ens.Request
{

/// Patient ID (PID-3, first CX component — the MR number).
Property PatientID As %String(MAXLEN = 64) [ Required ];

/// Family name (PID-5.1).
Property LastName As %String(MAXLEN = 128);

/// Given name (PID-5.2).
Property FirstName As %String(MAXLEN = 128);

/// Middle initial or name (PID-5.3).
Property MiddleName As %String(MAXLEN = 64);

/// Date of birth in YYYYMMDD format (PID-7).
Property DateOfBirth As %String(MAXLEN = 8);

/// Administrative sex code: M / F / O / U (PID-8).
Property Sex As %String(MAXLEN = 1);

/// Street address line (PID-11.1).
Property AddressStreet As %String(MAXLEN = 256);

/// City (PID-11.3).
Property AddressCity As %String(MAXLEN = 128);

/// State (PID-11.4).
Property AddressState As %String(MAXLEN = 64);

/// Postal code (PID-11.5).
Property AddressZip As %String(MAXLEN = 16);

/// Home phone number (PID-13.1, first repetition).
Property HomePhone As %String(MAXLEN = 32);

/// Source HL7 message control ID (MSH-10) — for traceability.
Property SourceMessageID As %String(MAXLEN = 64);

/// ISO 8601 timestamp when this message was created (set by the DTL).
Property ExtractedAt As %String(MAXLEN = 32);


}
