/// Routing rule for the LabRouter Business Process.
/// Routes HL7 messages by message type to PIDExtractProcess:
///   ADT^A01 → PIDExtractProcess  (admit — always has a full PID segment)
///   ORU^R01 → PIDExtractProcess  (lab result — also carries PID)
///   All others → discarded (logged as unrouted by LabRouter)
Class ProductionGuardian.LabDemo.RoutingRule Extends Ens.Rule.Definition
{

Parameter RuleAssistClass = "EnsLib.HL7.MsgRouter.RuleAssist";

XData RuleDefinition [ XMLNamespace = "http://www.intersystems.com/rule" ]
{
<ruleDefinition alias="" context="EnsLib.HL7.MsgRouter.RoutingEngine" production="ProductionGuardian.LabDemo.Production">
  <ruleSet name="" effectiveBegin="" effectiveEnd="">

    <!-- ADT^A01 admit notifications: extract PID and upsert patient demographics -->
    <rule name="Route ADT A01">
      <constraint name="msgClass" value="EnsLib.HL7.Message"/>
      <constraint name="docCategory" value="2.5"/>
      <constraint name="docName" value="ADT_A01"/>
      <when condition="1">
        <send transform="" target="PIDExtractProcess"/>
        <return/>
      </when>
    </rule>

    <!-- ORU^R01 lab results: also carry PID — upsert patient demographics -->
    <rule name="Route ORU R01">
      <constraint name="msgClass" value="EnsLib.HL7.Message"/>
      <constraint name="docCategory" value="2.5"/>
      <constraint name="docName" value="ORU_R01"/>
      <when condition="1">
        <send transform="" target="PIDExtractProcess"/>
        <return/>
      </when>
    </rule>

  </ruleSet>
</ruleDefinition>
}

}
