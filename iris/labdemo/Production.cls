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
    <!-- CallInterval, NOT PollInterval. EnsLib.File.InboundAdapter (the adapter that
         EnsLib.HL7.Service.FileService declares) has no property named PollInterval at
         all, so the setting was rejected on every production start and IRIS logged

           ERROR (Ens)ErrProductionSettingInvalid: Production setting 'PollInterval'
           for item 'EMR Source' is invalid

         into Ens.Util.Log as a Type=2 error row. Verified live: the row's timestamp
         matches the boot that wrote it, one per `compose up`. Two consequences, and the
         first is the one that matters. The demo instance accused ITSELF of a
         configuration error in the same event log the AI Detective reads for evidence.
         And the interval never applied at all: the adapter fell back to
         Ens.InboundAdapter's CallInterval default of 5s, which is why the pipeline kept
         working and nobody noticed.

         2 is the value this line always intended. The name is what was wrong.

         NOTE FOR ANYONE EDITING THIS COMMENT: a double hyphen is illegal inside an XML
         comment, and XData is parsed by a real XML parser. Writing one here fails the
         compile with #6301 and leaves the production unloadable. -->
    <Setting Target="Adapter" Name="CallInterval">2</Setting>
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
         from INSIDE the IRIS container. This is the SHIPPED value, and what a recompile
         restores, which is the whole reason it now has to be the working one.

         THIS SHIPPED `webgateway-webinar:80`, WHICH CAN NEVER RESOLVE FROM THIS STACK.
         That container belongs to a separate compose project. Measured, with it present
         on the host:

           pg-iris networks            ->  production-guardian_default only
           webgateway-webinar networks ->  iris_default
           getent hosts webgateway-webinar        ->  no result
           %Net.HttpRequest to webgateway-webinar ->  #6059 Unable to open TCP/IP socket

         They share no network, so whether that container is running changes NOTHING here.
         Do not record this as a dependency on another stack; it is not one.

         WHY THE VALUE FLAPPED, AND WITH IT THE FINDINGS. Nothing in the repo made this value
         work; a separate override did. FirstBoot.ApplyDeploymentSettings() rewrites it at
         first boot from ^ProductionGuardian.Setup, which docker/iris-firstboot.sh sets to
         127.0.0.1:52773 — so a clean volume delivered and any instance that lost the override
         did not. That override is marker-gated and never re-applied, and #96 measured it being
         discarded by a recompile (52773 before, 80 after `ck-d`), leaving Cloud API in Retry
         with the #6059 above. The result is a target that is correct or broken depending on
         history no one can see from the file, which is the "findings come and go" report.

         WHAT WAS NOT REPRODUCED, so the next reader does not trust one trigger too far: on a
         RUNNING production, neither `$system.OBJ.Compile(...,"ck-d")` nor a subsequent
         UpdateProduction() moved the stored value back to the XData below — the override
         survived both. So a recompile is a demonstrated way to lose it, not the only way and
         not a reliable way to demonstrate it. The fix does not depend on knowing the trigger.

         CheckDeploymentTarget() already detects this drift and deliberately only REPORTS it.
         Making the SHIPPED value the working one removes the drift at the source: whatever
         reverts to XData now reverts to something that works, and shipped and override agree
         so there is nothing to report in the default deployment. The override mechanism stays
         for a deployment that really is gateway-fronted (the demo instance) — it is now an
         override rather than a repair.

         WHY THE LOOPBACK IS RIGHT AGAIN. #34 moved off 127.0.0.1:52773 because nothing was
         listening there and every message failed with #6059 on that port. True of the image
         then, not of the AI Hub image this project ships now. Measured in the running
         container:

           netstat: tcp 0.0.0.0:52773 LISTEN
           %Net.HttpRequest localhost:52773 /labdemo/patients -> HTTP 403
           %Net.HttpRequest pg-iris:52773   /labdemo/patients -> HTTP 403

         403 is the CORRECT answer to an unauthenticated request and is what the Credentials
         setting below satisfies. So the premise of #34's fix expired when the image changed
         while the workaround it introduced survived, which is why the measurement is
         recorded here rather than summarised.

         `127.0.0.1` rather than `localhost` or `pg-iris`, for two reasons: it is the literal
         PG_IRIS_HTTP_SERVER default in docker/iris-firstboot.sh, so shipped and override now
         agree and a recompile is a no-op; and the listener above is IPv4-only, so a name that
         resolves to ::1 first would fail where the address cannot.

         Credentials are REQUIRED: the REST app answers 403 unauthenticated. Verified both ways
         from inside the container.

         Override per environment via ^ProductionGuardian.Setup or the Management Portal rather
         than editing this file; these are the only settings here that depend on the deployment. -->
    <Setting Target="Adapter" Name="HTTPServer">127.0.0.1</Setting>
    <Setting Target="Adapter" Name="HTTPPort">52773</Setting>
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
