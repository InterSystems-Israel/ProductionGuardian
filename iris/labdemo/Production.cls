/// LABDEMO production for Production Guardian Health Scan.
///
/// Pipeline:
///   EMRSource  →  LabRouter  →  PIDExtractProcess  →  PatientDemographicsOperation
///   (HL7 file)    (routing)      (DTL: HL7→PID msg)    (REST POST → PatientDispatcher)
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
       Business Service — EMRSource
       Reads HL7 v2 files dropped by the HL7Generator.
       ============================================================ -->
  <Item Name="EMRSource"
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
    <Setting Target="Host"    Name="TargetConfigNames">LabRouter</Setting>
    <Setting Target="Host"    Name="MessageSchemaCategory">2.5</Setting>
  </Item>

  <!-- ============================================================
       Business Process — LabRouter
       Routes ADT^A01 and ORU^R01 to PIDExtractProcess.
       Rule: ProductionGuardian.LabDemo.RoutingRule
       ============================================================ -->
  <Item Name="LabRouter"
        Category="LabDemo"
        ClassName="EnsLib.HL7.MsgRouter.RoutingEngine"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Routes HL7 by message type to PIDExtractProcess"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Host" Name="BusinessRuleName">ProductionGuardian.LabDemo.RoutingRule</Setting>
  </Item>

  <!-- ============================================================
       Business Process — PIDExtractProcess
       Applies the HL7ToPID DTL transform and forwards the resulting
       PatientDemographics message to PatientDemographicsOperation.
       ============================================================ -->
  <Item Name="PIDExtractProcess"
        Category="LabDemo"
        ClassName="ProductionGuardian.LabDemo.Process.PIDExtractProcess"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="Extracts PID segment via DTL; forwards PatientDemographics to REST operation"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Host" Name="TargetOperation">PatientDemographicsOperation</Setting>
  </Item>

  <!-- ============================================================
       Business Operation — PatientDemographicsOperation
       HTTP POSTs the PatientDemographics message as JSON to the
       PatientDispatcher REST API (same IRIS instance, /labdemo/patients).
       ============================================================ -->
  <Item Name="PatientDemographicsOperation"
        Category="LabDemo"
        ClassName="ProductionGuardian.LabDemo.Operation.PatientDemographicsOperation"
        PoolSize="1"
        Enabled="true"
        Foreground="false"
        Comment="POSTs patient demographics JSON to the PatientDispatcher REST API"
        LogTraceEvents="false"
        Schedule="">
    <Setting Target="Adapter" Name="HTTPServer">127.0.0.1</Setting>
    <Setting Target="Adapter" Name="HTTPPort">52773</Setting>
    <Setting Target="Adapter" Name="URL">/labdemo/patients</Setting>
    <Setting Target="Host"    Name="URL">/labdemo/patients</Setting>
  </Item>

  <!-- ============================================================
       Activity Reporter — required for iris_interop_avg_processing_time.
       ============================================================ -->
  <Item Name="ActivityReporter"
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
