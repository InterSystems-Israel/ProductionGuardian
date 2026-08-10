/// DTL transform: HL7 v2 message → PatientDemographics request message.
///
/// Extracts the PID segment from any inbound HL7 v2.x message and populates
/// a ProductionGuardian.LabDemo.Message.PatientDemographics instance.
///
/// Handles both ADT^A01 and ORU^R01 — both carry a PID segment.
/// If the PID segment is absent the transform still succeeds with empty fields
/// (the operation will reject an empty PatientID).
Class ProductionGuardian.LabDemo.Transform.HL7ToPID Extends Ens.DataTransformDTL [ DependsOn = (EnsLib.HL7.Message, ProductionGuardian.LabDemo.Message.PatientDemographics) ]
{

Parameter SOURCEDOC = "EnsLib.HL7.Message";
Parameter TARGETDOC = "ProductionGuardian.LabDemo.Message.PatientDemographics";

/// Transform: extract PID fields from the HL7 message.
/// Called by the routing engine; source is an EnsLib.HL7.Message object.
XData DTL [ XMLNamespace = "http://www.intersystems.com/dtl" ]
{
<transform sourceClass='EnsLib.HL7.Message'
           targetClass='ProductionGuardian.LabDemo.Message.PatientDemographics'
           sourceDocType='2.5:ADT_A01'
           create='new' language='objectscript' >

  <!-- PatientID: PID-3 first repetition, component 1 (the MR number CX.1) -->
  <assign value='source.{PID:3(1).1}' property='target.PatientID' action='set'/>

  <!-- Name: PID-5 first repetition, XPN components -->
  <assign value='source.{PID:5(1).1}' property='target.LastName'   action='set'/>
  <assign value='source.{PID:5(1).2}' property='target.FirstName'  action='set'/>
  <assign value='source.{PID:5(1).3}' property='target.MiddleName' action='set'/>

  <!-- Date of birth: PID-7 (TS, take first 8 chars for YYYYMMDD) -->
  <assign value='$extract(source.{PID:7},1,8)' property='target.DateOfBirth' action='set'/>

  <!-- Sex: PID-8 -->
  <assign value='source.{PID:8}' property='target.Sex' action='set'/>

  <!-- Address: PID-11 first repetition, XAD components -->
  <assign value='source.{PID:11(1).1}' property='target.AddressStreet' action='set'/>
  <assign value='source.{PID:11(1).3}' property='target.AddressCity'   action='set'/>
  <assign value='source.{PID:11(1).4}' property='target.AddressState'  action='set'/>
  <assign value='source.{PID:11(1).5}' property='target.AddressZip'    action='set'/>

  <!-- Home phone: PID-13 first repetition, XTN component 1 -->
  <assign value='source.{PID:13(1).1}' property='target.HomePhone' action='set'/>

  <!-- Traceability: source message control ID from MSH-10 -->
  <assign value='source.{MSH:10}' property='target.SourceMessageID' action='set'/>

  <!-- Timestamp of extraction -->
  <assign value='$zdatetime($ztimestamp,3,1)' property='target.ExtractedAt' action='set'/>

</transform>
}

}
