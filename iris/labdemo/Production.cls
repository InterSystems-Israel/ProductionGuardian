/// LABDEMO production for Production Guardian Health Scan.
///
/// Four components that model a realistic HL7 lab message pipeline:
///
///   EMRSource       — Business Service  — inbound HL7 v2 (file or TCP)
///   LabRouter       — Business Process  — routes by message type
///   FHIRTransform   — Business Process  — transforms HL7 → FHIR R4
///   CloudAPI        — Business Operation — HTTP forward to downstream
///
/// To load this production:
///   do $system.OBJ.Load("/path/to/iris/labdemo/Production.cls", "ck")
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
    Simulates a lab message pipeline: inbound HL7 → routing → FHIR transform → cloud HTTP.
  </Description>

  <!-- ============================================================
       Business Service — EMRSource
       Reads HL7 v2 messages from a local file drop directory.
       In a real deployment this would be an HL7 TCP listener.
       ============================================================ -->
  <Item Name="EMRSource"
        Category="LabDemo"
        ClassName="EnsLib.HL7.Service.FileService"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Inbound HL7 v2 messages from the EMR system (file drop for demo)"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Adapter" Name="FilePath">/tmp/labdemo/hl7-in/</Setting>
    <Setting Target="Adapter" Name="FileSpec">*.hl7</Setting>
    <Setting Target="Adapter" Name="ArchivePath">/tmp/labdemo/hl7-archive/</Setting>
    <Setting Target="Adapter" Name="PollInterval">2</Setting>
    <Setting Target="Host"    Name="TargetConfigNames">LabRouter</Setting>
    <Setting Target="Host"    Name="MessageSchemaCategory">2.5</Setting>
  </Item>

  <!-- ============================================================
       Business Process — LabRouter
       Routes messages by type: ADT goes to FHIRTransform, others dropped.
       ============================================================ -->
  <Item Name="LabRouter"
        Category="LabDemo"
        ClassName="EnsLib.HL7.MsgRouter.RoutingEngine"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Routes HL7 messages by type to the appropriate downstream"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Host" Name="BusinessRuleName">ProductionGuardian.LabDemo.RoutingRule</Setting>
  </Item>

  <!-- ============================================================
       Business Process — FHIRTransform
       Transforms HL7 v2 ADT/ORU messages to FHIR R4 resources.
       Uses a simple DTL for demo purposes.
       ============================================================ -->
  <Item Name="FHIRTransform"
        Category="LabDemo"
        ClassName="EnsLib.MsgRouter.RoutingEngine"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Transforms HL7 v2 to FHIR R4 JSON"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Host" Name="BusinessRuleName">ProductionGuardian.LabDemo.FHIRRoutingRule</Setting>
  </Item>

  <!-- ============================================================
       Business Operation — CloudAPI
       Sends FHIR JSON to a downstream HTTP endpoint.
       In demo mode, target is localhost:9999 (which may not be running —
       intentional: we want to be able to induce errors for Health Scan testing).
       ============================================================ -->
  <Item Name="CloudAPI"
        Category="LabDemo"
        ClassName="EnsLib.HTTP.OutboundAdapter"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="HTTP forward to downstream cloud FHIR API"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Adapter" Name="HTTPServer">localhost</Setting>
    <Setting Target="Adapter" Name="HTTPPort">9999</Setting>
    <Setting Target="Adapter" Name="URL">/fhir/r4</Setting>
    <Setting Target="Adapter" Name="SSLConfig"></Setting>
  </Item>

  <!-- ============================================================
       Activity Reporter — required for iris_interop_avg_processing_time.
       Add via Management Portal if not already present.
       ============================================================ -->
  <Item Name="ActivityReporter"
        Category="LabDemo"
        ClassName="Ens.Activity.Operation.Local"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Required: exposes per-host processing-time metrics to /api/monitor/metrics"
        LogTraceEvents="false"
        Schedule="">
  </Item>

</Production>
}

}
