/// LABDEMO production for Production Guardian Health Scan.
///
/// Pipeline (config item names, as they appear in metrics and the proxy JSON):
///   EMR Source  →  Lab Router  →  Cloud API
///   (HL7 file)     (routing +      (REST POST → PatientDispatcher)
///                   HL7ToPID DTL
///                   applied inline)
///
/// PatientDispatcher upserts patient demographics into:
///   ProductionGuardian.LabDemo.Data.PatientRecord (persistent table)
///
/// To load this production:
///   do $system.OBJ.LoadDir("/path/to/iris/labdemo/", "ck")
///
/// Then start it from the Management Portal or:
///   do ##class(Ens.Director).StartProduction("ProductionGuardian.LabDemo.Production")
Class ProductionGuardian.LabDemo.Production Extends Ens.Production
{

XData ProductionDefinition
{
<Production Name="ProductionGuardian.LabDemo.Production"
            LogGeneralTraceEvents="false">

  <Description>
    LABDEMO production for Production Guardian Health Scan MVP 1.
    Inbound HL7 v2 messages → PID extraction → patient demographics REST upsert.
  </Description>

  <!-- ============================================================
       Business Service — EMR Source
       Reads HL7 v2 files dropped by the HL7Generator.
       ============================================================ -->
  <Item Name="EMR Source"
        Category="LabDemo"
        ClassName="EnsLib.HL7.Service.FileService"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Inbound HL7 v2 messages from the EMR system (file drop)"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Adapter" Name="FilePath">/tmp/labdemo/hl7-in/</Setting>
    <Setting Target="Adapter" Name="FileSpec">*.hl7</Setting>
    <Setting Target="Adapter" Name="ArchivePath">/tmp/labdemo/hl7-archive/</Setting>
    <Setting Target="Adapter" Name="PollInterval">2</Setting>
    <Setting Target="Host"    Name="TargetConfigNames">Lab Router</Setting>
    <Setting Target="Host"    Name="MessageSchemaCategory">2.5</Setting>
  </Item>

  <!-- ============================================================
       Business Process — Lab Router
       Routes ADT^A01 to Cloud API.
       Rule: ProductionGuardian.LabDemo.RoutingRule
       ============================================================ -->
  <Item Name="Lab Router"
        Category="LabDemo"
        ClassName="EnsLib.HL7.MsgRouter.RoutingEngine"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Routes and transforms HL7 by message type to Cloud API"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Host" Name="BusinessRuleName">ProductionGuardian.LabDemo.RoutingRule</Setting>
  </Item>

  <!-- ============================================================
       Business Operation — PatientDemographicsOperation
       HTTP POSTs the PatientDemographics message as JSON to the
       PatientDispatcher REST API (same IRIS instance, /labdemo/patients).
       ============================================================ -->
  <Item Name="Cloud API"
        Category="LabDemo"
        ClassName="ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="POSTs patient demographics JSON to the PatientDispatcher REST API"
        LogTraceEvents="false"
        Schedule="">
    <!-- HTTPServer/HTTPPort must name the WEB SERVER that fronts this instance, reached
         from INSIDE the IRIS container. 127.0.0.1:52773 assumed a private web server in
         the same container; on the verified instance nothing listens there at all (only
         the superserver on 1972), so every message failed with

           ERROR #6059: Unable to open TCP/IP socket to server 127.0.0.1:52773

         and Cloud API sat in Retry having processed zero messages. Same wrong-port
         assumption as the one corrected in README.md (#48), this time in code (#34).

         Credentials are REQUIRED: through an external web gateway the REST app answers
         403 to an unauthenticated request even when /labdemo allows unauthenticated
         access locally. Verified both ways from inside the container — 403 without,
         200 {"count":0} with.

         Override all three per environment in the Management Portal rather than editing
         this file; they are the only settings here that depend on the deployment. -->
    <Setting Target="Adapter" Name="HTTPServer">webgateway-webinar</Setting>
    <Setting Target="Adapter" Name="HTTPPort">80</Setting>
    <Setting Target="Adapter" Name="Credentials">LabDemoREST</Setting>
    <Setting Target="Adapter" Name="URL">/labdemo/patients</Setting>
  </Item>

  <!-- ============================================================
       Activity Reporter — required for iris_interop_avg_processing_time.
       ============================================================ -->
  <Item Name="Ens.Activity.Operation.Local"
        Category="LabDemo"
        ClassName="Ens.Activity.Operation.Local"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Exposes per-host processing-time metrics to /api/monitor/metrics"
        LogTraceEvents="false"
        Schedule="">
  </Item>

</Production>
}

}
