/// Routing rule for the LabRouter Business Process.
/// Routes HL7 messages by message type:
///   ADT^A01 → FHIRTransform
///   ORU^R01 → FHIRTransform
///   All others → (discarded / no target, logged as unrouted)
Class ProductionGuardian.LabDemo.RoutingRule Extends Ens.Rule.Definition
{

Parameter RuleAssistClass = "EnsLib.HL7.MsgRouter.RuleAssist";

XData RuleDefinition [ XMLNamespace = "http://www.intersystems.com/rule" ]
{
<ruleDefinition alias="" context="EnsLib.HL7.MsgRouter.RoutingEngine" production="ProductionGuardian.LabDemo.Production">
  <ruleSet name="" effectiveBegin="" effectiveEnd="">

    <!-- Route ADT^A01 admit notifications to the FHIR transformer -->
    <rule name="Route ADT A01">
      <constraint name="msgClass" value="EnsLib.HL7.Message"/>
      <constraint name="docCategory" value="2.5"/>
      <constraint name="docName" value="ADT_A01"/>
      <when condition="1">
        <send transform="" target="FHIRTransform"/>
        <return/>
      </when>
    </rule>

    <!-- Route ORU^R01 lab results to the FHIR transformer -->
    <rule name="Route ORU R01">
      <constraint name="msgClass" value="EnsLib.HL7.Message"/>
      <constraint name="docCategory" value="2.5"/>
      <constraint name="docName" value="ORU_R01"/>
      <when condition="1">
        <send transform="" target="FHIRTransform"/>
        <return/>
      </when>
    </rule>

  </ruleSet>
</ruleDefinition>
}

}
