/// LABDEMO production for Production Guardian Health Scan.
///
/// Pipeline:
///   EMR Source  →  Lab Router  →  Cloud API
///   (HL7 file)     (routing +      (REST POST → PatientDispatcher)
///                   HL7→PID DTL)
///
/// Item names carry SPACES and are the join key between the proxy's host list and
/// the findings API (contracts/healthscan-api.md Q8) — the `host` label in
/// /api/monitor/metrics is the config item name verbatim. They must stay byte-equal
/// to contracts/samples/hosts-response.json; renaming an item here silently breaks
/// every finding that refers to it.
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
    <Setting Target="Adapter" Name="FilePath">C:\Practice\IN\HL7</Setting>
    <Setting Target="Adapter" Name="FileSpec">*.hl7</Setting>
    <Setting Target="Adapter" Name="ArchivePath">C:\Practice\ARCHIVE</Setting>
    <Setting Target="Adapter" Name="PollInterval">2</Setting>
    <!-- TargetConfigNames is a comma-delimited list, so a name containing spaces is
         fine — but do not add spaces after the comma when listing more than one. -->
    <Setting Target="Host"    Name="TargetConfigNames">Lab Router</Setting>
    <Setting Target="Host"    Name="MessageSchemaCategory">2.5</Setting>
  </Item>

  <!-- ============================================================
       Business Process — Lab Router
       Routes ADT^A01 to Cloud API, applying the HL7ToPID DTL on the send.
       Rule: ProductionGuardian.LabDemo.RoutingRule
       ============================================================ -->
  <Item Name="Lab Router"
        Category="LabDemo"
        ClassName="EnsLib.HL7.MsgRouter.RoutingEngine"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Routes ADT^A01 to Cloud API, transforming HL7 to PatientDemographics"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Host" Name="BusinessRuleName">ProductionGuardian.LabDemo.RoutingRule</Setting>
  </Item>

  <!-- ============================================================
       Business Operation — Cloud API
       HTTP POSTs the PatientDemographics message as JSON to the
       PatientDispatcher REST API (same IRIS instance, /labdemo/patients).

       Named "Cloud API" to match contracts/samples/ — it is the outbound HTTP
       operation forwarding to a downstream endpoint, which is the role the
       contract describes. The CLASS stays PatientDemographicsOperation; an item
       name and a class name are independent.
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
    <Setting Target="Adapter" Name="HTTPServer">127.0.0.1</Setting>
    <Setting Target="Adapter" Name="HTTPPort">80</Setting>
    <Setting Target="Adapter" Name="URL">/iris4health_2024_1/labdemo/patients</Setting>
   </Item>

  <!-- ============================================================
       Activity Reporter — required for iris_interop_avg_processing_time.

       Named with the `Ens.` prefix deliberately. The detection engine filters
       framework infrastructure by prefix on the ITEM name (isFrameworkHost in
       services/detection-engine/src/types/proxy.ts, PROXY-Q5), and it is the item
       name — not the class — that IRIS puts in the `host` metric label. Called
       plain "ActivityReporter" it leaks through as an application host with no
       throughput and manufactures a false dead_host finding.
       ============================================================ -->
  <Item Name="Ens.ActivityReporter"
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
